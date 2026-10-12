// Storage layer. Dual-mode:
//   - API mode: fetches from /api/data?table=cancellations and POSTs
//     mutations as targeted upserts (so webhook-written records don't
//     clobber CSR edits). Used in production (Vercel + Upstash).
//   - Local mode: localStorage only. Used in `npm run dev` without KV
//     env vars configured, so Phase-1 testing keeps working.
//
// Mode is detected on mount — if the API returns 501 (KV not provisioned),
// we stay on local. If API returns data, we switch to API mode but keep a
// localStorage shadow so a page reload shows last-known state instantly.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiReplace } from '../services/api.js';

const TABLE = 'cancellations';
const STORAGE_KEY = 'ivansTracker.cancellations';
const REFRESH_INTERVAL_MS = 30_000;

function readLocal() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function writeLocal(rows) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)); } catch {}
}

export function useCancellationData() {
  const [records, setRecords] = useState(readLocal);
  const [mode, setMode] = useState('local');   // 'local' | 'api'
  const [syncStatus, setSyncStatus] = useState('idle');  // 'idle' | 'loading' | 'synced' | 'error'
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // Initial pull + periodic refresh.
  const refresh = useCallback(async () => {
    setSyncStatus('loading');
    const r = await apiGet(TABLE);
    if (!r.ok) {
      if (r.reason === 'kv_not_provisioned') { setMode('local'); setSyncStatus('idle'); return; }
      setSyncStatus('error'); return;
    }
    setMode('api');
    const data = Array.isArray(r.data) ? r.data : [];
    writeLocal(data);
    setRecords(data);
    setSyncStatus('synced');
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);

  // Local storage sync across tabs in local mode.
  useEffect(() => {
    const onStorage = (e) => { if (e.key === STORAGE_KEY) setRecords(readLocal()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Shared mutate helper. Writes locally first for responsiveness, then
  // pushes to the API as a targeted upsert. In local mode, skips the API.
  const pushUpsert = useCallback(async (changedRows) => {
    if (modeRef.current !== 'api') return;
    await apiPost(TABLE, changedRows);
  }, []);

  const upsertMany = useCallback((incoming) => {
    const existing = readLocal();
    const byId = new Map(existing.map(r => [r.id, r]));
    let added = 0, updated = 0;
    const changed = [];
    for (const r of incoming) {
      if (byId.has(r.id)) {
        const prev = byId.get(r.id);
        const merged = {
          ...r,
          status: prev.status,
          assignedUser: prev.assignedUser,
          notes: prev.notes,
          amountDue: prev.amountDue || r.amountDue,
          cancelReason: prev.cancelReason || r.cancelReason,
          resolvedBy: r.resolvedBy || prev.resolvedBy,
          resolvedDate: r.resolvedDate || prev.resolvedDate,
          rewriteLevel: prev.overrideRewrite ? prev.rewriteLevel : r.rewriteLevel,
          newPolicy:    prev.overrideRewrite ? prev.newPolicy    : r.newPolicy,
          newCarrier:   prev.overrideRewrite ? prev.newCarrier   : r.newCarrier,
          newBindDate:  prev.overrideRewrite ? prev.newBindDate  : r.newBindDate,
          deltaDays:    prev.overrideRewrite ? prev.deltaDays    : r.deltaDays,
          rewriteAgent: prev.overrideRewrite ? prev.rewriteAgent : r.rewriteAgent,
          overrideRewrite: prev.overrideRewrite || false,
          createdAt: prev.createdAt,
          lastUpdated: new Date().toISOString(),
        };
        byId.set(r.id, merged);
        changed.push(merged);
        updated++;
      } else {
        byId.set(r.id, r);
        changed.push(r);
        added++;
      }
    }
    const next = [...byId.values()];
    writeLocal(next);
    setRecords(next);
    pushUpsert(changed);
    return { added, updated };
  }, [pushUpsert]);

  const applyResolves = useCallback((resolves) => {
    const existing = readLocal();
    const byPolicy = new Map();
    for (const r of existing) {
      if (r.status === 'resolved' || r.deleted) continue;
      const list = byPolicy.get(r.policyNumber) || [];
      list.push(r);
      byPolicy.set(r.policyNumber, list);
    }
    let resolved = 0;
    const changed = [];
    const now = new Date().toISOString();
    for (const rv of resolves) {
      const list = byPolicy.get(rv.policyNum);
      if (!list || !list.length) continue;
      list.sort((a, b) => (b.cancelDate || '').localeCompare(a.cancelDate || ''));
      const target = list[0];
      target.status = 'resolved';
      target.resolvedBy = rv.cycle || 'Reinstate';
      target.resolvedDate = rv.txDate;
      target.lastUpdated = now;
      changed.push(target);
      resolved++;
    }
    writeLocal(existing);
    setRecords(existing);
    if (changed.length) pushUpsert(changed);
    return { resolved };
  }, [pushUpsert]);

  const updateOne = useCallback((id, patch) => {
    const existing = readLocal();
    const idx = existing.findIndex(r => r.id === id);
    if (idx < 0) return;
    existing[idx] = { ...existing[idx], ...patch, lastUpdated: new Date().toISOString() };
    writeLocal(existing);
    setRecords(existing);
    pushUpsert([existing[idx]]);
  }, [pushUpsert]);

  const softDelete = useCallback((id) => updateOne(id, { deleted: true }), [updateOne]);

  const clearAll = useCallback(async () => {
    writeLocal([]);
    setRecords([]);
    if (modeRef.current === 'api') await apiReplace(TABLE, []);
  }, []);

  return { records, upsertMany, applyResolves, updateOne, softDelete, clearAll, mode, syncStatus, refresh };
}
