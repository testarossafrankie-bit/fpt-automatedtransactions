// Phase-2 KV CRUD. STUB — not wired until a dedicated Upstash is provisioned.
// Mirrors the portal's /api/data shape so the client swap is minimal:
//   GET  /api/data?table=cancellations         → array
//   POST /api/data?table=cancellations         → upsert single or replace
//   DEL  /api/data?table=cancellations&id=xxx  → soft/hard delete
//
// Until KV env vars are set in Vercel the endpoint responds 501 and the
// client stays on localStorage.

import { kv } from '@vercel/kv';

const hasKv = () =>
  Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!hasKv()) {
    return res.status(501).json({
      error: 'KV not provisioned',
      hint: 'Set KV_REST_API_URL + KV_REST_API_TOKEN env vars on Vercel. Client falls back to localStorage until this is wired.',
    });
  }

  const { table, id, mode } = req.query;
  if (!table) return res.status(400).json({ error: 'table required' });

  const key = `ivans-${table}`;

  try {
    if (req.method === 'GET') {
      const data = (await kv.get(key)) || [];
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const body = req.body;
      if (mode === 'replace') {
        await kv.set(key, body);
        return res.status(200).json({ ok: true, replaced: Array.isArray(body) ? body.length : 1 });
      }
      // Upsert by id (single object) or merge-many (array of objects).
      const incoming = Array.isArray(body) ? body : [body];
      const data = (await kv.get(key)) || [];
      const byId = new Map(data.map(r => [r.id, r]));
      for (const r of incoming) byId.set(r.id, { ...byId.get(r.id), ...r });
      const next = [...byId.values()];
      await kv.set(key, next);
      return res.status(200).json({ ok: true, upserted: incoming.length, total: next.length });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const data = (await kv.get(key)) || [];
      const next = data.filter(r => r.id !== id);
      await kv.set(key, next);
      return res.status(200).json({ ok: true, deleted: data.length - next.length });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
