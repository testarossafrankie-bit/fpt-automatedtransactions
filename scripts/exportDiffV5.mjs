// v5: tune rewrite detector for Foremost Premier (MetLife).
//
// Two upgrades over v4:
//  1. Fuzzy name match — a token set subset counts as a match. So IVANS
//     "STEVEN JOSEPH DESILVA" matches sales "Steven DeSilva" because the
//     sales tokens {desilva, steven} are a subset of IVANS tokens.
//  2. Foremost Premier (= MetLife Auto & Home, MEPR mailbox) auto-promotes
//     to STRONG even without an explicit r/w / rewrite tag, since CSRs
//     log MetLife rewrites without the tag by convention.

import fs from 'node:fs';
import { parseExport } from '../src/parsers/ezlynxIvans.js';
import { parseCsv } from '../src/lib/csv.js';

const SINCE = '2026-10-01';
const SALES_WINDOW_DAYS = 90;
const NBS_WINDOW_DAYS = 45;
const IVANS_CSV   = 'C:/Users/fterr/Downloads/exportDetails_20261009111525.csv';
const PORTAL_CSVS = [
  'C:/Users/fterr/Downloads/cancellations_export_2026-10-09.csv',
  'C:/Users/fterr/Downloads/cancellations_export_2026-10-09 (1).csv',
  'C:/Users/fterr/Downloads/cancellations_export_2026-10-09 (3).csv',
];
const SALES_CSV   = 'C:/Users/fterr/Downloads/sales_2026_10.csv';
const OUT_IVANS_ONLY  = 'C:/Users/fterr/Downloads/ivans_only_v5_since_2026-10-01.csv';
const OUT_PORTAL_ONLY = 'C:/Users/fterr/Downloads/dashboard_only_v5_since_2026-10-01.csv';

// Carriers whose sales entries conventionally lack the r/w tag.
// Any sales row from these carriers for a matching customer within window
// is treated as a STRONG rewrite signal.
const CARRIERS_IMPLICIT_REWRITE = new Set(['Foremost Premier']);

const normPolicy = s => String(s || '').replace(/\s+/g, '').toUpperCase();

function nameTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[,.()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length >= 2);
}
function nameKey(s) { return nameTokens(s).sort().join(' '); }

// Fuzzy name match — true if token sets overlap enough. Specifically:
// one side's tokens must be a subset of the other side's, AND they share
// at least a "last name" token (last alphabetically-sorted token on each
// side after dropping middle initials — close enough for insurance).
function fuzzyNameMatch(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return false;
  const [small, big] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  const bigSet = new Set(big);
  return small.every(t => bigSet.has(t));
}

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

// --- Portal: union of 3 tabs ---
const portalByKey = new Map();
for (const path of PORTAL_CSVS) {
  const rows = parseCsv(fs.readFileSync(path, 'utf8'));
  const h = rows[0]; const idx = Object.fromEntries(h.map((x, i) => [x, i]));
  for (const r of rows.slice(1).filter(r => r.length > 1 && r[0] !== '')) {
    const rec = {
      policyNumber: r[idx['Policy Number']],
      customerName: r[idx['Customer']],
      carrier:      r[idx['Carrier']],
      cancelReason: r[idx['Cancel Reason']],
      cancelDate:   toIso(r[idx['Cancel Date']]),
      amountDue:    r[idx['Amount Due']],
      status:       r[idx['Status']],
      assignedTo:   r[idx['Assigned To']],
      notes:        r[idx['Notes']],
    };
    if (rec.cancelDate < SINCE) continue;
    const k = normPolicy(rec.policyNumber);
    const rank = { 'Not Started': 5, 'Attempted': 4, 'Contacted': 3, 'Resolved': 2, 'Cancelled': 1 };
    const prev = portalByKey.get(k);
    if (!prev || (rank[rec.status] || 0) > (rank[prev.status] || 0)) portalByKey.set(k, rec);
  }
}
const portal = [...portalByKey.values()];

// --- IVANS ---
const parsed = parseExport(fs.readFileSync(IVANS_CSV, 'utf8'));
const ivans = parsed.records.filter(r => (r.cancelDate || '') >= SINCE);
const ivansByPolicy = new Map();
for (const r of ivans) {
  const k = normPolicy(r.policyNumber);
  if (!ivansByPolicy.has(k)) ivansByPolicy.set(k, []);
  ivansByPolicy.get(k).push(r);
}

// --- Sales (indexed by name tokens for fuzzy match) ---
const salesRows = parseCsv(fs.readFileSync(SALES_CSV, 'utf8'));
const sh = salesRows[0]; const sIdx = Object.fromEntries(sh.map((x, i) => [x, i]));
const sales = salesRows.slice(1).filter(r => r.length > 1 && r[0] !== '').map(r => ({
  customer:  r[sIdx['Customer']],
  tokens:    nameTokens(r[sIdx['Customer']]),
  carrier:   r[sIdx['Carrier']],
  policyNum: r[sIdx['Policy #']],
  source:    r[sIdx['Source']],
  agent:     r[sIdx['Agent']],
  bindDate:  r[sIdx['Bind Date']],
  isExplicitRewrite: /r\/w|rewrite|prog-trav/i.test(`${r[sIdx['Policy #']] || ''} ${r[sIdx['Source']] || ''}`),
}));

// --- IVANS NBS (indexed by name tokens) ---
const nbs = parseCsv(fs.readFileSync(IVANS_CSV, 'utf8')).slice(1)
  .filter(r => r && r.length >= 20 && r[19] === 'NBS')
  .map(r => ({ policyNumber: r[9], carrier: r[5], insured: r[11], tokens: nameTokens(r[11]), date: toIso(r[14]) || toIso(r[12]) }));

function findSalesCandidates(cxlTokens) {
  return sales.filter(s => fuzzyNameMatch(cxlTokens, s.tokens));
}
function findNbsCandidates(cxlTokens) {
  return nbs.filter(n => fuzzyNameMatch(cxlTokens, n.tokens));
}

function classifyRewrite(cxl) {
  const cxlTokens = nameTokens(cxl.customerName);
  if (!cxlTokens.length) return null;

  const salesCandidates = findSalesCandidates(cxlTokens);

  // 1) STRONG via explicit r/w tag
  for (const s of salesCandidates) {
    if (!s.isExplicitRewrite) continue;
    const d = daysBetween(cxl.cancelDate, s.bindDate);
    if (d <= SALES_WINDOW_DAYS) return mkRewrite('STRONG', s, d);
  }
  // 1b) STRONG via implicit-rewrite carrier (Foremost Premier etc.)
  for (const s of salesCandidates) {
    if (!CARRIERS_IMPLICIT_REWRITE.has(s.carrier)) continue;
    if (normPolicy(s.policyNum) === normPolicy(cxl.policyNumber)) continue;
    const d = daysBetween(cxl.cancelDate, s.bindDate);
    if (d <= SALES_WINDOW_DAYS) return mkRewrite('STRONG', s, d);
  }
  // 2) LIKELY: any other sales match, different policy, within window
  for (const s of salesCandidates) {
    if (normPolicy(s.policyNum) === normPolicy(cxl.policyNumber)) continue;
    const d = daysBetween(cxl.cancelDate, s.bindDate);
    if (d <= SALES_WINDOW_DAYS) return mkRewrite('LIKELY', s, d);
  }
  // 3) NBS_ONLY: IVANS NBS fallback
  for (const n of findNbsCandidates(cxlTokens)) {
    if (n.policyNumber === cxl.policyNumber) continue;
    const d = daysBetween(cxl.cancelDate, n.date);
    if (d <= NBS_WINDOW_DAYS) return { level: 'NBS_ONLY', newPolicy: n.policyNumber, newCarrier: n.carrier, newDate: n.date, deltaDays: Math.round(d), agent: '' };
  }
  return null;
}
function mkRewrite(level, s, d) {
  return { level, newPolicy: s.policyNum, newCarrier: s.carrier, newDate: s.bindDate, deltaDays: Math.round(d), agent: s.agent };
}

const ivansOnly = ivans.filter(r => !portalByKey.has(normPolicy(r.policyNumber)));
const portalOnly = portal.filter(r => !ivansByPolicy.has(normPolicy(r.policyNumber)));

const flagged = ivansOnly.map(r => {
  const rw = classifyRewrite(r);
  return { ...r, rewriteLevel: rw?.level || '', newPolicy: rw?.newPolicy || '', newCarrier: rw?.newCarrier || '',
           newBindDate: rw?.newDate || '', deltaDays: rw?.deltaDays ?? '', rewriteAgent: rw?.agent || '' };
});

const byLevel = { STRONG: 0, LIKELY: 0, NBS_ONLY: 0, NONE: 0 };
for (const r of flagged) byLevel[r.rewriteLevel || 'NONE']++;

function esc(v) { const s = v == null ? '' : String(v); return `"${s.replace(/"/g,'""')}"`; }
function toCsv(headers, rows) {
  return headers.map(esc).join(',') + '\n' + rows.map(r => headers.map(k => esc(r[k])).join(',')).join('\n') + '\n';
}

const sortRank = { '': 0, 'NBS_ONLY': 1, 'LIKELY': 2, 'STRONG': 3 };
fs.writeFileSync(OUT_IVANS_ONLY, toCsv(
  ['rewriteLevel','newPolicy','newCarrier','newBindDate','deltaDays','rewriteAgent','policyNumber','carrier','customerName','cancelDate','bucket','cycle','status','resolvedBy','LOB','fromMailbox'],
  flagged.sort((a, b) => { const r = sortRank[a.rewriteLevel] - sortRank[b.rewriteLevel]; return r !== 0 ? r : (a.cancelDate || '').localeCompare(b.cancelDate || ''); })
));
fs.writeFileSync(OUT_PORTAL_ONLY, toCsv(
  ['policyNumber','carrier','customerName','cancelDate','cancelReason','amountDue','status','assignedTo','notes'],
  portalOnly.sort((a, b) => (a.cancelDate || '').localeCompare(b.cancelDate || ''))
));

function tally(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
const realIvansOnly = flagged.filter(r => !r.rewriteLevel);

console.log('═══════════════════════════════════════════════════════════');
console.log(`Window: cancelDate >= ${SINCE}  |  Portal unioned  |  Fuzzy name match + Foremost Premier auto-strong`);
console.log('═══════════════════════════════════════════════════════════');
console.log(`Portal (unioned): ${portal.length}`);
console.log(`IVANS:            ${ivans.length}`);
console.log(`In both:          ${portal.length - portalOnly.length}`);
console.log();
console.log(`IVANS-only:                     ${ivansOnly.length}`);
console.log(`  STRONG rewrite:               ${byLevel.STRONG}`);
console.log(`  LIKELY rewrite:               ${byLevel.LIKELY}`);
console.log(`  NBS_ONLY rewrite:             ${byLevel.NBS_ONLY}`);
console.log(`  Real cancellations missed:    ${byLevel.NONE}`);
console.log(`Dashboard-only:                 ${portalOnly.length}`);
console.log();
console.log('─── Real IVANS-only by carrier ───');
tally(realIvansOnly, r => r.carrier).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log(`\n→ ${OUT_IVANS_ONLY}`);
console.log(`→ ${OUT_PORTAL_ONLY}`);
