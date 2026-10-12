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

  // Shared-secret auth (optional). Accept via either X-Webhook-Secret header
  // or ?secret= query param. EZLynx Reports 5.0 uses Looker Studio under
  // the hood which doesn't support custom headers — URL param is the only
  // way to pass auth from their scheduler.
  const expected = process.env.WEBHOOK_SECRET;
  if (expected) {
    const got = req.headers['x-webhook-secret'] || req.query.secret;
    if (got !== expected) {
      await logAttempt({ outcome: 'reject-401', report, headerKeys, hasSecretHeader: !!req.headers['x-webhook-secret'], hasSecretQuery: !!req.query.secret, bodySize });
      return res.status(401).json({ error: 'bad secret' });
    }
  }

  if (report !== 'ptd' && report !== 'pending') {
    await logAttempt({ outcome: 'reject-400', report, headerKeys, bodySize });
    return res.status(400).json({ error: 'report query param must be "ptd" or "pending"' });
  }

  // EZLynx Reports 5.0 uses Looker Studio for webhook delivery. The POST
  // body is a wrapper envelope:
  //   { type: "query", scheduled_plan: { ... }, attachment: { data: "..." }, ... }
  //
  // The real row data lives in one of a few places depending on report type:
  //   - attachment.data as a JSON string (most common for JSON — Simple format)
  //   - scheduled_plan.query_result as an array
  //   - scheduled_plan.data as an array
  const payload = req.body;
  const contentType = req.headers['content-type'] || '';
  const bodySample = (() => {
    try {
      const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return s ? s.slice(0, 4000) : '(empty)';
    } catch { return '(unserializable)'; }
  })();
  const serializedSize = (() => {
    try { return typeof payload === 'string' ? payload.length : JSON.stringify(payload).length; } catch { return 0; }
  })();

  // Try to unwrap Looker's envelope.
  function extractRows(p) {
    if (Array.isArray(p)) return p;
    if (!p || typeof p !== 'object') return null;
    // Common wrapper fields
    if (Array.isArray(p.data)) return p.data;
    if (Array.isArray(p.rows)) return p.rows;
    // Looker-specific paths
    const sp = p.scheduled_plan || {};
    if (Array.isArray(sp.query_result)) return sp.query_result;
    if (Array.isArray(sp.data)) return sp.data;
    // Looker JSON attachment: base64-encoded or raw string
    if (p.attachment) {
      const att = p.attachment;
      const raw = att.data || att.content || '';
      if (raw) {
        try { const decoded = typeof raw === 'string' && raw.length && raw[0] !== '[' && raw[0] !== '{'
          ? Buffer.from(raw, 'base64').toString('utf8') : raw;
          const parsed = typeof decoded === 'string' ? JSON.parse(decoded) : decoded;
          if (Array.isArray(parsed)) return parsed;
          if (Array.isArray(parsed?.data)) return parsed.data;
          if (Array.isArray(parsed?.rows)) return parsed.rows;
        } catch {}
      }
    }
    return null;
  }

  const rows = extractRows(payload);
  if (!Array.isArray(rows)) {
    await logAttempt({
      outcome: 'reject-400-body', report, headerKeys,
      bodyType: typeof payload, bodySize: serializedSize,
      bodyKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
      scheduledPlanKeys: payload?.scheduled_plan ? Object.keys(payload.scheduled_plan).slice(0, 20) : [],
      attachmentKeys: payload?.attachment ? Object.keys(payload.attachment).slice(0, 20) : [],
      contentType, bodySample,
    });
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
    contentType,
    bodySize: serializedSize,
    bodySample,
    rawCount: parsed.rawCount,
    kept: parsed.records.length,
    added, updated, resolved,
    rewriteCount: parsed.rewriteCount,
    dropped: parsed.dropped,
  });
  await kv.set(AUDIT_KEY, audit.slice(0, AUDIT_CAP));

  return res.status(200).json({ ok: true, report, added, updated, resolved, rawCount: parsed.rawCount });
}
