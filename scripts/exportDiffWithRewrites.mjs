// Same diff as exportDiff.mjs, but flags IVANS-only cancellations that look
// like rewrites: same insured appears as NBS (new business) somewhere in the
// IVANS batch within ±45 days of the cancel. These policies left under one
// number and came back under another — not real churn, so CSRs skip them.

import fs from 'node:fs';
import { parseExport } from '../src/parsers/ezlynxIvans.js';
import { parseCsv } from '../src/lib/csv.js';

const SINCE = '2026-10-01';
const WINDOW_DAYS = 45;
const IVANS_CSV      = 'C:/Users/fterr/Downloads/exportDetails_20261009111525.csv';
const PORTAL_CSV     = 'C:/Users/fterr/Downloads/cancellations_export_2026-10-09 (1).csv';
const OUT_IVANS_ONLY = 'C:/Users/fterr/Downloads/ivans_only_since_2026-10-01.csv';
const OUT_PORTAL_ONLY= 'C:/Users/fterr/Downloads/dashboard_only_since_2026-10-01.csv';

const normPolicy = s => String(s || '').replace(/\s+/g, '').toUpperCase();
const normName   = s => String(s || '').replace(/[,.]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

function toIso(s) {
  if (!s) return '';
  const t = String(s).trim();
  const slash = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2,'0')}-${slash[2].padStart(2,'0')}`;
  if (/^(\d{4})-(\d{2})-(\d{2})$/.test(t)) return t;
  return '';
}
function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

// --- Portal side ---
const portalRows = parseCsv(fs.readFileSync(PORTAL_CSV, 'utf8'));
const h = portalRows[0];
const idx = Object.fromEntries(h.map((x, i) => [x, i]));
const portal = portalRows.slice(1).filter(r => r.length > 1 && r[0] !== '').map(r => ({
  policyNumber: r[idx['Policy Number']],
  customerName: r[idx['Customer']],
  carrier:      r[idx['Carrier']],
  cancelReason: r[idx['Cancel Reason']],
  cancelDate:   toIso(r[idx['Cancel Date']]),
  amountDue:    r[idx['Amount Due']],
  status:       r[idx['Status']],
  assignedTo:   r[idx['Assigned To']],
  notes:        r[idx['Notes']],
})).filter(r => r.cancelDate >= SINCE);
const portalByPolicy = new Map(portal.map(r => [normPolicy(r.policyNumber), r]));

// --- IVANS cancellation records ---
const parsed = parseExport(fs.readFileSync(IVANS_CSV, 'utf8'));
const ivans = parsed.records.filter(r => (r.cancelDate || '') >= SINCE);
const ivansByPolicy = new Map();
for (const r of ivans) {
  const k = normPolicy(r.policyNumber);
  if (!ivansByPolicy.has(k)) ivansByPolicy.set(k, []);
  ivansByPolicy.get(k).push(r);
}

// --- Rewrite detection: all NBS rows in the IVANS batch ---
// Parse the raw CSV again to pull NBS entries (parser filters them out).
const rawRows = parseCsv(fs.readFileSync(IVANS_CSV, 'utf8'));
const nbsByName = new Map();
for (const r of rawRows.slice(1)) {
  if (!r || r.length < 20) continue;
  const cycle = r[19];
  if (cycle !== 'NBS') continue;
  const insured = normName(r[11]);
  const txDate = toIso(r[14]) || toIso(r[12]); // transaction date, fallback eff date
  if (!insured) continue;
  const list = nbsByName.get(insured) || [];
  list.push({
    policyNumber: r[9],
    insured: r[11],
    carrier: r[5],
    date: txDate,
    LOB: r[18],
  });
  nbsByName.set(insured, list);
}

function likelyRewrite(cxl) {
  const key = normName(cxl.customerName);
  const matches = nbsByName.get(key) || [];
  for (const nbs of matches) {
    if (nbs.policyNumber === cxl.policyNumber) continue; // same policy — not a rewrite
    const d = daysBetween(cxl.cancelDate, nbs.date);
    if (d <= WINDOW_DAYS) {
      return { newPolicy: nbs.policyNumber, newCarrier: nbs.carrier, newDate: nbs.date, deltaDays: Math.round(d) };
    }
  }
  return null;
}

// --- Diff ---
const ivansOnly = ivans.filter(r => !portalByPolicy.has(normPolicy(r.policyNumber)));
const portalOnly = portal.filter(r => !ivansByPolicy.has(normPolicy(r.policyNumber)));

// Flag rewrites on IVANS-only.
let rewriteCount = 0;
const flagged = ivansOnly.map(r => {
  const rw = likelyRewrite(r);
  if (rw) rewriteCount++;
  return { ...r, likelyRewrite: rw ? 'YES' : '', newPolicy: rw?.newPolicy || '', newCarrierMailbox: rw?.newCarrier || '', newBindDate: rw?.newDate || '', deltaDays: rw?.deltaDays ?? '' };
});

// --- CSV writers ---
function esc(v) { const s = v == null ? '' : String(v); return `"${s.replace(/"/g,'""')}"`; }
function toCsv(headers, rows) {
  return headers.map(esc).join(',') + '\n' + rows.map(r => headers.map(k => esc(r[k])).join(',')).join('\n') + '\n';
}

const ivansOnlyCsv = toCsv(
  ['likelyRewrite','newPolicy','newCarrierMailbox','newBindDate','deltaDays','policyNumber','carrier','customerName','cancelDate','bucket','cycle','status','resolvedBy','LOB','fromMailbox'],
  flagged.sort((a, b) => {
    // Sort: rewrites first grouping = NO before YES, then by cancelDate
    if ((a.likelyRewrite === 'YES') !== (b.likelyRewrite === 'YES')) return a.likelyRewrite === 'YES' ? 1 : -1;
    return (a.cancelDate || '').localeCompare(b.cancelDate || '');
  })
);
const portalOnlyCsv = toCsv(
  ['policyNumber','carrier','customerName','cancelDate','cancelReason','amountDue','status','assignedTo','notes'],
  portalOnly.sort((a, b) => (a.cancelDate || '').localeCompare(b.cancelDate || ''))
);

fs.writeFileSync(OUT_IVANS_ONLY, ivansOnlyCsv);
fs.writeFileSync(OUT_PORTAL_ONLY, portalOnlyCsv);

console.log(`Window: cancelDate >= ${SINCE}`);
console.log(`Portal records in window:   ${portal.length}`);
console.log(`IVANS records in window:    ${ivans.length}`);
console.log(`In both:                    ${portal.length - portalOnly.length}`);
console.log(`\nIVANS-only:                 ${ivansOnly.length}`);
console.log(`  flagged as rewrite:       ${rewriteCount}`);
console.log(`  real signal (not rewrite): ${ivansOnly.length - rewriteCount}`);
console.log(`Dashboard-only:             ${portalOnly.length}`);
console.log(`\n→ ${OUT_IVANS_ONLY}`);
console.log(`→ ${OUT_PORTAL_ONLY}`);
