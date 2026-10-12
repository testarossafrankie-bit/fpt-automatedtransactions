// Smoke test: parse the sample CSV through the real parser module and
// print per-bucket counts. Verifies the port from scratch/parse.js worked.
//
// Run from repo root: node scripts/smoke.mjs
import fs from 'node:fs';
import { parseExport } from '../src/parsers/ezlynxIvans.js';

const CSV = process.argv[2] || 'C:\\Users\\fterr\\Downloads\\exportDetails_20261009091614.csv';
const text = fs.readFileSync(CSV, 'utf8');
const r = parseExport(text);

const by = { cancelled: 0, pending: 0, unpaid_bill: 0 };
for (const rec of r.records) by[rec.bucket]++;

console.log(`File: ${CSV}`);
console.log(`Raw transactions:         ${r.rawCount}`);
console.log(`Normalized records:       ${r.records.length}`);
console.log(`  Cancelled:              ${by.cancelled}`);
console.log(`  Pending:                ${by.pending}`);
console.log(`  Unpaid Bill:            ${by.unpaid_bill}`);
console.log(`In-batch resolves:        ${r.resolvedPairs.length}`);
console.log(`Unmatched resolves:       ${r.unmatchedResolves.length}`);
console.log(`Dropped cycles:           ${r.dropped.length} distinct`);
