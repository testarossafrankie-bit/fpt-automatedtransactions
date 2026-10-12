// Sales log storage. Two refresh paths:
//   - CSV upload (manual fallback)
//   - fetchFromPortal() (default — pulls from portal KV + caches)
//
// Shape stored: Array<{ customer, carrier, type, policyNum, premium,
//   agent, source, bindDate, effDate, bundled }>

import { useCallback, useEffect, useState } from 'react';
import { parseCsv } from '../lib/csv.js';

const STORAGE_KEY = 'ivansTracker.salesLog';
const META_KEY = 'ivansTracker.salesLogMeta';
const PORTAL_URL = 'https://fbi-portal-source.vercel.app/api/data?table=sales';
// Only keep sales bound in the last ~6 months — enough to catch rewrites
// for a cancel firing today, keeps localStorage from ballooning.
const WINDOW_DAYS = 180;
const AUTO_REFRESH_HOURS = 12;

function toIso(s) {
  if (!s) return '';
  const t = String(s).trim();
  const slash = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2,'0')}-${slash[2].padStart(2,'0')}`;
  if (/^(\d{4})-(\d{2})-(\d{2})$/.test(t)) return t;
  return '';
}

function readAll()  { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function readMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch { return null; } }

export function useSalesLog() {
  const [salesLog, setSalesLog] = useState(readAll);
  const [meta, setMeta] = useState(readMeta);

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === STORAGE_KEY) setSalesLog(readAll());
      if (e.key === META_KEY)    setMeta(readMeta());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Expect CSV with headers: Customer, Carrier, Type, Policy #, Premium,
  // Agent, Source, Bind Date, Eff Date, Bundled (portal /sales export).
  const importCsv = useCallback((csvText, fileName) => {
    const rows = parseCsv(csvText);
    if (!rows.length) throw new Error('Empty CSV');
    const h = rows[0];
    const idx = Object.fromEntries(h.map((x, i) => [String(x).trim(), i]));
    const need = ['Customer', 'Carrier', 'Policy #', 'Bind Date'];
    for (const n of need) if (idx[n] === undefined) throw new Error(`Missing column: ${n}`);

    const data = rows.slice(1).filter(r => r && r.length > 1 && r[0] !== '').map(r => ({
      customer:  r[idx['Customer']],
      carrier:   r[idx['Carrier']],
      type:      r[idx['Type']] ?? '',
      policyNum: r[idx['Policy #']],
      premium:   r[idx['Premium']] ?? '',
      agent:     r[idx['Agent']] ?? '',
      source:    r[idx['Source']] ?? '',
      bindDate:  toIso(r[idx['Bind Date']]),
      effDate:   toIso(r[idx['Eff Date']] ?? ''),
      bundled:   r[idx['Bundled']] ?? '',
    }));

    const newMeta = { fileName, count: data.length, uploadedAt: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    localStorage.setItem(META_KEY, JSON.stringify(newMeta));
    setSalesLog(data);
    setMeta(newMeta);
    return newMeta;
  }, []);

  const clear = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(META_KEY);
    setSalesLog([]);
    setMeta(null);
  }, []);

  // Fetch sales table from the portal KV. Normalizes the record shape to
  // what the classifier expects, filters to recent binds, writes to cache.
  // Returns { count } or throws.
  const refreshFromPortal = useCallback(async () => {
    const res = await fetch(PORTAL_URL);
    if (!res.ok) throw new Error(`Portal API ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Portal returned non-array');

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    const normalized = data
      .filter(r => r && (r.bindDate || '') >= cutoffIso)
      .map(r => ({
        customer:  r.customerName || r.customer || '',
        carrier:   r.carrier || '',
        type:      r.type || r.lineOfBusiness || '',
        policyNum: r.policyNumber || r['Policy #'] || '',
        premium:   r.premium || '',
        agent:     r.agent || r.salesperson || '',
        source:    r.source || '',
        bindDate:  r.bindDate || '',
        effDate:   r.effDate || '',
        bundled:   r.bundled || '',
      }));

    const newMeta = { source: 'portal', count: normalized.length, uploadedAt: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    localStorage.setItem(META_KEY, JSON.stringify(newMeta));
    setSalesLog(normalized);
    setMeta(newMeta);
    return newMeta;
  }, []);

  // Auto-refresh on mount if cache is stale or empty.
  useEffect(() => {
    const stale = !meta
      || !meta.uploadedAt
      || (Date.now() - new Date(meta.uploadedAt).getTime()) > AUTO_REFRESH_HOURS * 3600 * 1000;
    if (stale) refreshFromPortal().catch(() => { /* non-fatal — user can retry */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { salesLog, meta, importCsv, clear, refreshFromPortal };
}
