// EZLynx scheduled-report webhook endpoint. Accepts POST with the JSON body
// of either Policy Transaction Detail or Pending Transactions Detail.
// Writes normalized cancellation records to KV, deduped by Policy Transaction ID.
//
// Report routing: EZLynx can send a report name in the URL as a query param
// so one webhook URL serves both. e.g.
//   POST /api/webhook/ezlynx?report=ptd      ← Policy Transaction Detail
//   POST /api/webhook/ezlynx?report=pending  ← Pending Transactions Detail
//
// Auth: optional X-Webhook-Secret header matched against WEBHOOK_SECRET env.
// Without the env var set, the endpoint accepts anonymous POSTs (dev mode).

import { kv } from '@vercel/kv';
import { parsePtd } from '../../src/parsers/ezlynxPtd.js';
import { parsePending } from '../../src/parsers/ezlynxPending.js';

const KEY = 'ivans-cancellations';
const AUDIT_KEY = 'ivans-webhook-audit';
const AUDIT_CAP = 500;

const hasKv = () =>
  Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

// Diagnostic logger — writes to the webhook audit table on every attempt,
// including rejections. Helps surface auth / payload issues without needing
// Vercel log access.
async function logAttempt(entry) {
  if (!hasKv()) return;
  try {
    const audit = (await kv.get(AUDIT_KEY)) || [];
    audit.unshift({ at: new Date().toISOString(), ...entry });
    await kv.set(AUDIT_KEY, audit.slice(0, AUDIT_CAP));
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!hasKv()) return res.status(501).json({ error: 'KV not provisioned' });

  const report = (req.query.report || '').toLowerCase();
  const headerKeys = Object.keys(req.headers || {}).sort();
  const bodySize = Buffer.isBuffer(req.body) ? req.body.length
                 : Array.isArray(req.body) ? req.body.length
                 : typeof req.body === 'string' ? req.body.length : 0;

  // Shared-secret auth (optional)
  const expected = process.env.WEBHOOK_SECRET;
  if (expected) {
    const got = req.headers['x-webhook-secret'];
    if (got !== expected) {
      await logAttempt({ outcome: 'reject-401', report, headerKeys, hasSecretHeader: !!got, bodySize });
      return res.status(401).json({ error: 'bad secret' });
    }
  }

  if (report !== 'ptd' && report !== 'pending') {
    await logAttempt({ outcome: 'reject-400', report, headerKeys, bodySize });
    return res.status(400).json({ error: 'report query param must be "ptd" or "pending"' });
  }

  // EZLynx JSON Simple format is typically an array of row objects.
  // Some providers wrap in { data: [...] }. Handle both.
  const payload = req.body;
  const rows = Array.isArray(payload) ? payload : (payload?.data || payload?.rows || []);
  if (!Array.isArray(rows)) {
    await logAttempt({ outcome: 'reject-400-body', report, headerKeys, bodyType: typeof payload, bodySize, bodyKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 10) : [] });
    return res.status(400).json({ error: 'body must be an array (or { data: [...] })' });
  }

  const parsed = report === 'ptd' ? parsePtd(rows) : parsePending(rows);

  // Upsert into KV by Policy Transaction ID (stable key from EZLynx).
  const existing = (await kv.get(KEY)) || [];
  const byId = new Map(existing.map(r => [r.id, r]));
  let added = 0, updated = 0;
  for (const r of parsed.records) {
    if (byId.has(r.id)) {
      const prev = byId.get(r.id);
      byId.set(r.id, {
        ...r,
        // Preserve CSR-owned workflow fields on re-ingest.
        status:       prev.status,
        assignedUser: prev.assignedUser,
        notes:        prev.notes,
        createdAt:    prev.createdAt,
        lastUpdated:  new Date().toISOString(),
      });
      updated++;
    } else {
      byId.set(r.id, r);
      added++;
    }
  }

  // Apply resolves — Reinstate rows mark the most recent open cancel for the
  // same policyNumber as resolved.
  let resolved = 0;
  for (const rv of parsed.resolves) {
    const candidates = [...byId.values()]
      .filter(x => x.policyNumber === rv.policyNumber && !x.deleted && x.status !== 'resolved')
      .sort((a, b) => (b.cancelDate || '').localeCompare(a.cancelDate || ''));
    if (candidates.length) {
      const target = candidates[0];
      target.status = 'resolved';
      target.resolvedBy = 'Reinstate';
      target.resolvedDate = rv.resolvedDate;
      target.lastUpdated = new Date().toISOString();
      byId.set(target.id, target);
      resolved++;
    }
  }

  const next = [...byId.values()];
  await kv.set(KEY, next);

  // Audit log — cap at 500 entries.
  const audit = (await kv.get(AUDIT_KEY)) || [];
  audit.unshift({
    at: new Date().toISOString(),
    report,
    rawCount: parsed.rawCount,
    kept: parsed.records.length,
    added, updated, resolved,
    rewriteCount: parsed.rewriteCount,
    dropped: parsed.dropped,
  });
  await kv.set(AUDIT_KEY, audit.slice(0, AUDIT_CAP));

  return res.status(200).json({ ok: true, report, added, updated, resolved, rawCount: parsed.rawCount });
}
