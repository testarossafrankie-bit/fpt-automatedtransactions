// Summary stats for the 10/1+ comparison with rewrites filtered out.

import fs from 'node:fs';
import { parseExport } from '../src/parsers/ezlynxIvans.js';
import { parseCsv } from '../src/lib/csv.js';

const SINCE = '2026-10-01';
const SALES_WINDOW_DAYS = 90;
const NBS_WINDOW_DAYS = 45;
const IVANS_CSV   = 'C:/Users/fterr/Downloads/exportDetails_20261009111525.csv';
const PORTAL_CSV  = 'C:/Users/fterr/Downloads/cancellations_export_2026-10-09 (1).csv';
const SALES_CSV   = 'C:/Users/fterr/Downloads/sales_2026_10.csv';

const normPolicy = s => String(s || '').replace(/\s+/g, '').toUpperCase();
function nameTokens(s) {
  return String(s || '').toLowerCase().replace(/[,.()]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(t => t.length >= 2);
}
function nameKey(s) { return nameTokens(s).sort().join(' '); }
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

// Load everything
const portalRows = parseCsv(fs.readFileSync(PORTAL_CSV, 'utf8'));
const ph = portalRows[0]; const pIdx = Object.fromEntries(ph.map((x, i) => [x, i]));
const portal = portalRows.slice(1).filter(r => r.length > 1 && r[0] !== '').map(r => ({
  policyNumber: r[pIdx['Policy Number']], customerName: r[pIdx['Customer']],
  carrier: r[pIdx['Carrier']], cancelDate: toIso(r[pIdx['Cancel Date']]),
  status: r[pIdx['Status']],
})).filter(r => r.cancelDate >= SINCE);
const portalByPolicy = new Map(portal.map(r => [normPolicy(r.policyNumber), r]));

const parsed = parseExport(fs.readFileSync(IVANS_CSV, 'utf8'));
const ivans = parsed.records.filter(r => (r.cancelDate || '') >= SINCE);
const ivansByPolicy = new Map();
for (const r of ivans) {
  const k = normPolicy(r.policyNumber);
  if (!ivansByPolicy.has(k)) ivansByPolicy.set(k, []);
  ivansByPolicy.get(k).push(r);
}

const salesRows = parseCsv(fs.readFileSync(SALES_CSV, 'utf8'));
const sh = salesRows[0]; const sIdx = Object.fromEntries(sh.map((x, i) => [x, i]));
const sales = salesRows.slice(1).filter(r => r.length > 1 && r[0] !== '').map(r => ({
  customer: r[sIdx['Customer']], carrier: r[sIdx['Carrier']],
  policyNum: r[sIdx['Policy #']], source: r[sIdx['Source']],
  bindDate: r[sIdx['Bind Date']],
  isExplicitRewrite: /r\/w|rewrite|prog-trav/i.test(`${r[sIdx['Policy #']] || ''} ${r[sIdx['Source']] || ''}`),
}));
const salesByName = new Map();
for (const s of sales) {
  const key = nameKey(s.customer);
  if (!key) continue;
  (salesByName.get(key) || salesByName.set(key, []).get(key)).push(s);
}
const nbsByName = new Map();
for (const row of parseCsv(fs.readFileSync(IVANS_CSV, 'utf8')).slice(1)) {
  if (!row || row.length < 20 || row[19] !== 'NBS') continue;
  const key = nameKey(row[11]);
  if (!key) continue;
  (nbsByName.get(key) || nbsByName.set(key, []).get(key)).push({ policyNumber: row[9], carrier: row[5], date: toIso(row[14]) || toIso(row[12]) });
}

function isRewrite(cxl) {
  const key = nameKey(cxl.customerName);
  if (!key) return false;
  for (const s of salesByName.get(key) || []) {
    if (s.isExplicitRewrite && daysBetween(cxl.cancelDate, s.bindDate) <= SALES_WINDOW_DAYS) return true;
    if (normPolicy(s.policyNum) !== normPolicy(cxl.policyNumber) && daysBetween(cxl.cancelDate, s.bindDate) <= SALES_WINDOW_DAYS) return true;
  }
  for (const n of nbsByName.get(key) || []) {
    if (n.policyNumber !== cxl.policyNumber && daysBetween(cxl.cancelDate, n.date) <= NBS_WINDOW_DAYS) return true;
  }
  return false;
}

const ivansOnly = ivans.filter(r => !portalByPolicy.has(normPolicy(r.policyNumber)));
const portalOnly = portal.filter(r => !ivansByPolicy.has(normPolicy(r.policyNumber)));
const ivansOnlyReal = ivansOnly.filter(r => !isRewrite(r));
const ivansOnlyRewrite = ivansOnly.filter(r => isRewrite(r));

function tally(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

console.log('═══════════════════════════════════════════════════════════');
console.log(`Window: cancelDate >= ${SINCE}  (rewrites excluded from Dashboard)`);
console.log('═══════════════════════════════════════════════════════════');
console.log();
console.log('                           TOTAL   IN BOTH   ONLY HERE');
console.log(`  IVANS (non-rewrite):      ${String(ivans.length - ivansOnlyRewrite.length).padEnd(5)}   ${String(ivans.length - ivansOnlyRewrite.length - ivansOnlyReal.length).padEnd(7)}   ${ivansOnlyReal.length}`);
console.log(`  Dashboard:                ${String(portal.length).padEnd(5)}   ${String(portal.length - portalOnly.length).padEnd(7)}   ${portalOnly.length}`);
console.log();
console.log(`  Rewrites filtered out of IVANS: ${ivansOnlyRewrite.length}`);
console.log();
console.log('─── IVANS-only (real cancellations CSRs missed), by carrier ───');
tally(ivansOnlyReal, r => r.carrier).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log();
console.log('─── IVANS-only, by bucket ───');
tally(ivansOnlyReal, r => r.bucket).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log();
console.log('─── Dashboard-only (CSRs tracking, IVANS doesn\'t show), by carrier ───');
tally(portalOnly, r => r.carrier || '(blank)').forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log();
console.log('─── Dashboard-only, by status ───');
tally(portalOnly, r => r.status || '(blank)').forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
