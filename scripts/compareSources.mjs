// What's in IVANS exportDetails that isn't in EZLynx PTD + Pending?
// Both filtered to cancelDate >= 2026-10-07.
import fs from 'node:fs';
import { parseExport as parseIvans } from '../src/parsers/ezlynxIvans.js';
import { parsePtd } from '../src/parsers/ezlynxPtd.js';
import { parsePending } from '../src/parsers/ezlynxPending.js';
import { mergeDuplicates } from '../src/data/cancellations.js';

const SINCE = '2026-10-07';
const IVANS = 'C:/Users/fterr/Downloads/exportDetails_20261012102324.csv';
const PTD = 'C:/Users/fterr/Downloads/Policy Transaction Detail 2026-10-12T1102.csv';
const PENDING = 'C:/Users/fterr/Downloads/Pending Transactions Detail 2026-10-12T1107.csv';

const norm = s => String(s || '').replace(/\s+/g, '').toUpperCase();

// IVANS side
const ivans = parseIvans(fs.readFileSync(IVANS, 'utf8')).records
  .filter(r => (r.cancelDate || '') >= SINCE);
const ivansByPolicy = new Map();
for (const r of ivans) {
  const k = norm(r.policyNumber);
  if (!ivansByPolicy.has(k)) ivansByPolicy.set(k, []);
  ivansByPolicy.get(k).push(r);
}

// EZLynx side (merged PTD + Pending)
const ptd = parsePtd(fs.readFileSync(PTD, 'utf8'));
const pending = parsePending(fs.readFileSync(PENDING, 'utf8'));
const combined = [...ptd.records, ...pending.records];
const ezRecs = mergeDuplicates(combined);
// EZLynx cancelDate is often empty for PTD-only records — fall back to
// downloadDate for the comparison window.
const ez = ezRecs.filter(r => {
  const ref = r.cancelDate || r.downloadDate || r.effectiveDate || '';
  return ref >= SINCE;
});
const ezByPolicy = new Map();
for (const r of ez) ezByPolicy.set(norm(r.policyNumber), r);

const ivansOnly = ivans.filter(r => !ezByPolicy.has(norm(r.policyNumber)));
const ezOnly = ez.filter(r => !ivansByPolicy.has(norm(r.policyNumber)));

console.log(`Window: cancelDate >= ${SINCE}`);
console.log(`IVANS exportDetails records:        ${ivans.length}`);
console.log(`EZLynx PTD + Pending (merged):      ${ez.length}`);
console.log(`In both (by policy #):              ${ivans.length - ivansOnly.length}`);
console.log(`IVANS-only (missing from EZLynx):   ${ivansOnly.length}`);
console.log(`EZLynx-only (missing from IVANS):   ${ezOnly.length}`);

if (ivansOnly.length) {
  console.log('\n═══ IVANS-only (what EZLynx reports are missing) ═══');
  console.log('POLICY             CARRIER           LOB    CYCLE  CANCEL      CUSTOMER');
  ivansOnly.sort((a,b) => (a.cancelDate||'').localeCompare(b.cancelDate||''))
    .forEach(r => console.log(`  ${(r.policyNumber||'').padEnd(16)} ${(r.carrier||'').padEnd(17)} ${(r.LOB||'').padEnd(6)} ${(r.cycle||'').padEnd(6)} ${(r.cancelDate||'').padEnd(11)} ${r.customerName||''}`));
}
if (ezOnly.length) {
  console.log('\n═══ EZLynx-only (what IVANS exportDetails is missing) ═══');
  ezOnly.sort((a,b) => (a.cancelDate||a.downloadDate||'').localeCompare(b.cancelDate||b.downloadDate||''))
    .forEach(r => console.log(`  ${(r.policyNumber||'').padEnd(16)} ${(r.carrier||'').padEnd(17)} ${(r.transactionType||'').padEnd(22)} ${(r.cancelDate||r.downloadDate||'').padEnd(11)} ${r.customerName||''}`));
}

// Also check field-level coverage: for records in both, does EZLynx carry
// everything IVANS has?
const bothPolicies = ivans.filter(r => ezByPolicy.has(norm(r.policyNumber)));
let missingCycleReason = 0;   // IVANS has XLN (non-pay), EZLynx doesn't distinguish
for (const r of bothPolicies) {
  if (r.cycle === 'XLN') missingCycleReason++;
}
console.log(`\nField-level gaps (records in both sources):`);
console.log(`  IVANS XLN (Progressive non-pay) rows: ${missingCycleReason}`);
console.log(`  → EZLynx collapses these into "Cancel Req" with no reason-code field`);
