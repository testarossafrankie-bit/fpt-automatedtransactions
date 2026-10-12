// Rewrite detection v2: cross-reference IVANS-only cancellations against the
// portal's sales log. Fuzzy name matching, bind-date window, three signals:
//
//   STRONG  — sales row w/ policy # or source containing r/w|rewrite|prog-trav
//   LIKELY  — sales row for same customer, bindDate within ±90d of cancel
//   NBS-only — IVANS NBS match only (fallback from v1)

import fs from 'node:fs';
import { parseExport } from '../src/parsers/ezlynxIvans.js';
import { parseCsv } from '../src/lib/csv.js';

const SINCE = '2026-10-01';
const SALES_WINDOW_DAYS = 90;
const NBS_WINDOW_DAYS = 45;
const IVANS_CSV   = 'C:/Users/fterr/Downloads/exportDetails_20261009111525.csv';
const PORTAL_CSV  = 'C:/Users/fterr/Downloads/cancellations_export_2026-10-09 (1).csv';
const SALES_CSV   = 'C:/Users/fterr/Downloads/sales_2026_10.csv';
const OUT_IVANS_ONLY  = 'C:/Users/fterr/Downloads/ivans_only_v3_since_2026-10-01.csv';
const OUT_PORTAL_ONLY = 'C:/Users/fterr/Downloads/dashboard_only_v3_since_2026-10-01.csv';

const normPolicy = s => String(s || '').replace(/\s+/g, '').toUpperCase();
// Canonical name: lowercase, drop punctuation, sort tokens alphabetically.
// So "Rhoden, Myesha" and "Myesha Rhoden" both → "myesha rhoden".
// Also handles "KURT A MCCANN" vs "Kurt McCann" imperfectly — middle initial
// becomes an extra token; we match by set-intersection score below.
function nameTokens(s) {
  return String(s || '').toLowerCase()
    .replace(/[,.()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length >= 2);  // drop middle initials
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

// --- Portal cancellations ---
const portalRows = parseCsv(fs.readFileSync(PORTAL_CSV, 'utf8'));
const ph = portalRows[0];
const pIdx = Object.fromEntries(ph.map((x, i) => [x, i]));
const portal = portalRows.slice(1).filter(r => r.length > 1 && r[0] !== '').map(r => ({
  policyNumber: r[pIdx['Policy Number']],
  customerName: r[pIdx['Customer']],
  carrier:      r[pIdx['Carrier']],
  cancelReason: r[pIdx['Cancel Reason']],
  cancelDate:   toIso(r[pIdx['Cancel Date']]),
  amountDue:    r[pIdx['Amount Due']],
  status:       r[pIdx['Status']],
  assignedTo:   r[pIdx['Assigned To']],
  notes:        r[pIdx['Notes']],
})).filter(r => r.cancelDate >= SINCE);
const portalByPolicy = new Map(portal.map(r => [normPolicy(r.policyNumber), r]));

// --- IVANS cancellations ---
const parsed = parseExport(fs.readFileSync(IVANS_CSV, 'utf8'));
const ivans = parsed.records.filter(r => (r.cancelDate || '') >= SINCE);
const ivansByPolicy = new Map();
for (const r of ivans) {
  const k = normPolicy(r.policyNumber);
  if (!ivansByPolicy.has(k)) ivansByPolicy.set(k, []);
  ivansByPolicy.get(k).push(r);
}

// --- Sales log (portal) ---
const salesRows = parseCsv(fs.readFileSync(SALES_CSV, 'utf8'));
const sh = salesRows[0];
const sIdx = Object.fromEntries(sh.map((x, i) => [x, i]));
const sales = salesRows.slice(1).filter(r => r.length > 1 && r[0] !== '').map(r => ({
  customer:  r[sIdx['Customer']],
  carrier:   r[sIdx['Carrier']],
  type:      r[sIdx['Type']],
  policyNum: r[sIdx['Policy #']],
  agent:     r[sIdx['Agent']],
  source:    r[sIdx['Source']],
  bindDate:  r[sIdx['Bind Date']],
  isExplicitRewrite: /r\/w|rewrite|prog-trav/i.test(`${r[sIdx['Policy #']] || ''} ${r[sIdx['Source']] || ''}`),
}));
const salesByName = new Map();
for (const s of sales) {
  const key = nameKey(s.customer);
  if (!key) continue;
  const list = salesByName.get(key) || [];
  list.push(s);
  salesByName.set(key, list);
}

// --- IVANS NBS log (within the batch) ---
const nbsByName = new Map();
for (const row of salesRows.length ? parseCsv(fs.readFileSync(IVANS_CSV, 'utf8')).slice(1) : []) {
  if (!row || row.length < 20) continue;
  if (row[19] !== 'NBS') continue;
  const key = nameKey(row[11]);
  if (!key) continue;
  const list = nbsByName.get(key) || [];
  list.push({
    policyNumber: row[9],
    insured: row[11],
    carrier: row[5],
    date: toIso(row[14]) || toIso(row[12]),
  });
  nbsByName.set(key, list);
}

// --- Rewrite classifier ---
function classifyRewrite(cxl) {
  const key = nameKey(cxl.customerName);
  if (!key) return null;

  // 1) STRONG: explicit r/w flag in sales
  const salesMatches = salesByName.get(key) || [];
  for (const s of salesMatches) {
    if (!s.isExplicitRewrite) continue;
    const d = daysBetween(cxl.cancelDate, s.bindDate);
    if (d <= SALES_WINDOW_DAYS) {
      return { level: 'STRONG', newPolicy: s.policyNum, newCarrier: s.carrier, newDate: s.bindDate, deltaDays: Math.round(d), agent: s.agent };
    }
  }
  // 2) LIKELY: sales row for same customer, close in time, different policy
  for (const s of salesMatches) {
    if (normPolicy(s.policyNum) === normPolicy(cxl.policyNumber)) continue;
    const d = daysBetween(cxl.cancelDate, s.bindDate);
    if (d <= SALES_WINDOW_DAYS) {
      return { level: 'LIKELY', newPolicy: s.policyNum, newCarrier: s.carrier, newDate: s.bindDate, deltaDays: Math.round(d), agent: s.agent };
    }
  }
  // 3) NBS-only: IVANS NBS match
  const nbsMatches = nbsByName.get(key) || [];
  for (const n of nbsMatches) {
    if (n.policyNumber === cxl.policyNumber) continue;
    const d = daysBetween(cxl.cancelDate, n.date);
    if (d <= NBS_WINDOW_DAYS) {
      return { level: 'NBS_ONLY', newPolicy: n.policyNumber, newCarrier: n.carrier, newDate: n.date, deltaDays: Math.round(d), agent: '' };
    }
  }
  return null;
}

const ivansOnly = ivans.filter(r => !portalByPolicy.has(normPolicy(r.policyNumber)));
const portalOnly = portal.filter(r => !ivansByPolicy.has(normPolicy(r.policyNumber)));

const flagged = ivansOnly.map(r => {
  const rw = classifyRewrite(r);
  return {
    ...r,
    rewriteLevel:    rw?.level || '',
    newPolicy:       rw?.newPolicy || '',
    newCarrier:      rw?.newCarrier || '',
    newBindDate:     rw?.newDate || '',
    deltaDays:       rw?.deltaDays ?? '',
    rewriteAgent:    rw?.agent || '',
  };
});

const byLevel = { STRONG: 0, LIKELY: 0, NBS_ONLY: 0, NONE: 0 };
for (const r of flagged) byLevel[r.rewriteLevel || 'NONE']++;

// --- CSVs ---
function esc(v) { const s = v == null ? '' : String(v); return `"${s.replace(/"/g,'""')}"`; }
function toCsv(headers, rows) {
  return headers.map(esc).join(',') + '\n' + rows.map(r => headers.map(k => esc(r[k])).join(',')).join('\n') + '\n';
}

const sortRank = { '': 0, 'NBS_ONLY': 1, 'LIKELY': 2, 'STRONG': 3 };
const ivansOnlyCsv = toCsv(
  ['rewriteLevel','newPolicy','newCarrier','newBindDate','deltaDays','rewriteAgent','policyNumber','carrier','customerName','cancelDate','bucket','cycle','status','resolvedBy','LOB','fromMailbox'],
  flagged.sort((a, b) => {
    const r = sortRank[a.rewriteLevel] - sortRank[b.rewriteLevel];
    if (r !== 0) return r;
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
console.log(`Portal records: ${portal.length}`);
console.log(`IVANS records:  ${ivans.length}`);
console.log(`In both:        ${portal.length - portalOnly.length}`);
console.log(`\nIVANS-only:     ${ivansOnly.length}`);
console.log(`  STRONG rewrite (explicit r/w in sales): ${byLevel.STRONG}`);
console.log(`  LIKELY rewrite (customer + close date): ${byLevel.LIKELY}`);
console.log(`  NBS_ONLY rewrite (fallback):            ${byLevel.NBS_ONLY}`);
console.log(`  No rewrite signal (real cancellations): ${byLevel.NONE}`);
console.log(`Dashboard-only: ${portalOnly.length}`);
console.log(`\n→ ${OUT_IVANS_ONLY}`);
console.log(`→ ${OUT_PORTAL_ONLY}`);
