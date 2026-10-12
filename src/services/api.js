// Thin API client. Points at the local Vercel dev server (same origin) in
// prod, or a proxied path in dev. Falls back gracefully when KV isn't
// provisioned so `npm run dev` without env vars keeps working on
// localStorage alone.

const BASE = '/api';

export async function apiGet(table) {
  const r = await fetch(`${BASE}/data?table=${encodeURIComponent(table)}`);
  if (r.status === 501) return { ok: false, reason: 'kv_not_provisioned' };
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
  const data = await r.json();
  return { ok: true, data };
}

// Upsert one or many records by id. Merges with existing KV state.
export async function apiPost(table, body) {
  const r = await fetch(`${BASE}/data?table=${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 501) return { ok: false, reason: 'kv_not_provisioned' };
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
  return { ok: true, data: await r.json() };
}

// Hard-replace the whole table. Use for the "clear all" admin action.
export async function apiReplace(table, body) {
  const r = await fetch(`${BASE}/data?table=${encodeURIComponent(table)}&mode=replace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 501) return { ok: false, reason: 'kv_not_provisioned' };
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
  return { ok: true, data: await r.json() };
}

export async function apiDelete(table, id) {
  const r = await fetch(`${BASE}/data?table=${encodeURIComponent(table)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (r.status === 501) return { ok: false, reason: 'kv_not_provisioned' };
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
  return { ok: true };
}
