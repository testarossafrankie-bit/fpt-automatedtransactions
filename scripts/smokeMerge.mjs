// Simulate the full "two-report + sales-log + merge" flow and show counts.
import fs from 'node:fs';
import { parsePtd } from '../src/parsers/ezlynxPtd.js';
import { parsePending } from '../src/parsers/ezlynxPending.js';
import { tabForRecord, mergeDuplicates } from '../src/data/cancellations.js';

const PTD = 'C:/Users/fterr/Downloads/Policy Transaction Detail 2026-10-12T1102.csv';
const PENDING = 'C:/Users/fterr/Downloads/Pending Transactions Detail 2026-10-12T1107.csv';

// Fetch sales log from portal (same path the hook uses).
const r = await fetch('https://fbi-portal-source.vercel.app/api/data?table=sales');
const salesData = await r.json();
const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 180);
const cutoffIso = cutoff.toISOString().slice(0, 10);
const salesLog = salesData
  .filter(x => (x.bindDate || '') >= cutoffIso)
  .map(x => ({
    customer: x.customerName || x.customer || '',
    carrier: x.carrier || '', policyNum: x.policyNumber || '',
    source: x.source || '', agent: x.agent || '',
    bindDate: x.bindDate || '',
  }));
console.log(`Sales log: ${salesLog.length} rows`);

const ptd = parsePtd(fs.readFileSync(PTD, 'utf8'), { salesLog });
const pending = parsePending(fs.readFileSync(PENDING, 'utf8'), { salesLog });

console.log(`\nPTD:    ${ptd.records.length} records, ${ptd.rewriteCount} rewrites (incl classifier)`);
console.log(`Pend:   ${pending.records.length} records, ${pending.rewriteCount} rewrites (incl classifier)`);

const combined = [...ptd.records, ...pending.records];
console.log(`\nCombined before merge: ${combined.length}`);
const merged = mergeDuplicates(combined);
console.log(`Combined after merge:  ${merged.length}`);
console.log(`  → ${combined.length - merged.length} duplicates collapsed`);

const by = { save: 0, cancelled: 0, rewrites: 0 };
for (const rec of merged) by[tabForRecord(rec)]++;
console.log(`\nTab routing (merged):`);
console.log(`  Save Queue:     ${by.save}`);
console.log(`  Already Cancel: ${by.cancelled}`);
console.log(`  Rewrites:       ${by.rewrites}`);

// Which records got classifier-flagged (cross-carrier rewrites)?
const classifierCatch = merged.filter(r => r.rewriteLevel && !['Rewrite', 'Cancel Rewrite'].includes(r.transactionType));
console.log(`\nCross-carrier rewrites caught by classifier: ${classifierCatch.length}`);
classifierCatch.slice(0, 10).forEach(r => {
  console.log(`  [${r.rewriteLevel.padEnd(8)}] ${r.carrier.padEnd(17)} ${r.policyNumber.padEnd(16)} ${r.customerName} → ${r.newCarrier} ${r.newPolicy}`);
});
