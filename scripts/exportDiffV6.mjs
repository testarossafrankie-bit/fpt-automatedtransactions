// v6: 8/11+ window, parses the full oct-12 IVANS batch, fetches portal
// cancellations + sales directly from the portal API (CORS-open, no auth),
// runs the same rewrite classifier as the app, writes diff CSVs.

import fs from 'node:fs';
import { parseExport } from '../src/parsers/ezlynxIvans.js';

const SINCE = '2026-08-11';
const IVANS_CSV = 'C:/Users/fterr/Downloads/exportDetails_20261012102324.csv';
const PORTAL_URL_CANCELS = 'https://fbi-portal-source.vercel.app/api/data?table=cancellations';
const PORTAL_URL_SALES   = 'https://fbi-portal-source.vercel.app/api/data?table=sales';
const OUT_IVANS_ONLY  = 'C:/Users/fterr/Downloads/ivans_only_v6_since_2026-08-11.csv';
const OUT_PORTAL_ONLY = 'C:/Users/fterr/Downloads/dashboard_only_v6_since_2026-08-11.csv';

const normPolicy = s => String(s || '').replace(/\s+/g, '').toUpperCase();

async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }

const [portalCxl, portalSales] = await Promise.all([j(PORTAL_URL_CANCELS), j(PORTAL_URL_SALES)]);
console.log('Portal cancellations:', portalCxl.length);
console.log('Portal sales:        ', portalSales.length);

// Normalize sales to classifier shape.
const salesNormalized = portalSales
  .filter(r => r && (r.bindDate || '') >= '2026-04-15')
  .map(r => ({
    customer:  r.customerName || r.customer || '',
    carrier:   r.carrier || '',
    policyNum: r.policyNumber || r['Policy #'] || '',
    source:    r.source || '',
    agent:     r.agent || r.salesperson || '',
    bindDate:  r.bindDate || '',
  }));

const parsed = parseExport(fs.readFileSync(IVANS_CSV, 'utf8'), { salesLog: salesNormalized });
console.log('IVANS raw:   ', parsed.rawCount);
console.log('IVANS kept:  ', parsed.records.length);
console.log('  STRONG rewrite: ', parsed.rewriteCounts.STRONG);
console.log('  LIKELY rewrite: ', parsed.rewriteCounts.LIKELY);
console.log('  NBS_ONLY rewrite:', parsed.rewriteCounts.NBS_ONLY);

const ivans = parsed.records.filter(r => (r.cancelDate || '') >= SINCE);
const ivansByPolicy = new Map();
for (const r of ivans) {
  const k = normPolicy(r.policyNumber);
  if (!ivansByPolicy.has(k)) ivansByPolicy.set(k, []);
  ivansByPolicy.get(k).push(r);
}

// Portal: dedupe by policy, filter to >= SINCE
const portalByKey = new Map();
for (const r of portalCxl) {
  if (!r || r.deleted) continue;
  if ((r.cancelDate || '') < SINCE) continue;
  const k = normPolicy(r.policyNumber);
  const rank = { 'Not Started': 5, 'Attempted': 4, 'Contacted': 3, 'Resolved': 2, 'Cancelled': 1 };
  const prev = portalByKey.get(k);
  if (!prev || (rank[r.status] || 0) > (rank[prev.status] || 0)) portalByKey.set(k, r);
}
const portal = [...portalByKey.values()];

const ivansOnly  = ivans.filter(r => !portalByKey.has(normPolicy(r.policyNumber)));
const portalOnly = portal.filter(r => !ivansByPolicy.has(normPolicy(r.policyNumber)));

const realIvansOnly = ivansOnly.filter(r => !r.rewriteLevel);
const rewriteIvansOnly = ivansOnly.filter(r =>  r.rewriteLevel);

function esc(v) { const s = v == null ? '' : String(v); return `"${s.replace(/"/g,'""')}"`; }
function toCsv(headers, rows) { return headers.map(esc).join(',') + '\n' + rows.map(r => headers.map(k => esc(r[k])).join(',')).join('\n') + '\n'; }

const sortRank = { '': 0, 'NBS_ONLY': 1, 'LIKELY': 2, 'STRONG': 3 };
fs.writeFileSync(OUT_IVANS_ONLY, toCsv(
  ['rewriteLevel','newPolicy','newCarrier','newBindDate','deltaDays','rewriteAgent','policyNumber','carrier','customerName','cancelDate','bucket','cycle','status','resolvedBy','LOB','fromMailbox'],
  ivansOnly.sort((a, b) => { const r = sortRank[a.rewriteLevel||''] - sortRank[b.rewriteLevel||'']; return r !== 0 ? r : (a.cancelDate || '').localeCompare(b.cancelDate || ''); })
));
fs.writeFileSync(OUT_PORTAL_ONLY, toCsv(
  ['policyNumber','carrier','customerName','cancelDate','cancelReason','amountDue','status','assignedUser','notes'],
  portalOnly
    .map(r => ({ policyNumber: r.policyNumber, carrier: r.carrier, customerName: r.customerName, cancelDate: r.cancelDate, cancelReason: r.cancelReason, amountDue: r.amountDue, status: r.status, assignedUser: r.assignedUser || r.assignedTo || '', notes: r.notes || '' }))
    .sort((a, b) => (a.cancelDate || '').localeCompare(b.cancelDate || ''))
));

function tally(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

console.log();
console.log('═══════════════════════════════════════════════════════════');
console.log(`Window: cancelDate >= ${SINCE}  |  Portal via API  |  IVANS batch oct-12`);
console.log('═══════════════════════════════════════════════════════════');
console.log(`Portal:     ${portal.length}`);
console.log(`IVANS:      ${ivans.length}`);
console.log(`In both:    ${portal.length - portalOnly.length}`);
console.log();
console.log(`IVANS-only:        ${ivansOnly.length}`);
console.log(`  real misses:     ${realIvansOnly.length}`);
console.log(`  flagged rewrite: ${rewriteIvansOnly.length}`);
console.log(`Dashboard-only:    ${portalOnly.length}`);
console.log();
console.log('─── Real IVANS-only (CSRs missed) by carrier ───');
tally(realIvansOnly, r => r.carrier).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log();
console.log('─── Real IVANS-only by bucket ───');
tally(realIvansOnly, r => r.bucket).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log();
console.log('─── Dashboard-only by status ───');
tally(portalOnly, r => r.status || '(blank)').forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log();
console.log(`→ ${OUT_IVANS_ONLY}`);
console.log(`→ ${OUT_PORTAL_ONLY}`);
