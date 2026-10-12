import fs from 'node:fs';
import { parsePtd } from '../src/parsers/ezlynxPtd.js';
import { parsePending } from '../src/parsers/ezlynxPending.js';
import { tabForRecord } from '../src/data/cancellations.js';

const PTD = 'C:/Users/fterr/Downloads/Policy Transaction Detail 2026-10-12T1102.csv';
const PENDING = 'C:/Users/fterr/Downloads/Pending Transactions Detail 2026-10-12T1107.csv';

function run(label, parser, file) {
  console.log(`\n═══ ${label} ═══`);
  const r = parser(fs.readFileSync(file, 'utf8'));
  console.log(`Raw: ${r.rawCount}`);
  console.log(`Kept: ${r.records.length}`);
  console.log(`Resolves: ${r.resolves.length}`);
  const by = { save: 0, cancelled: 0, rewrites: 0 };
  for (const rec of r.records) by[tabForRecord(rec)]++;
  console.log(`  Save Queue:     ${by.save}`);
  console.log(`  Already Cancel: ${by.cancelled}`);
  console.log(`  Rewrites:       ${by.rewrites}`);
  console.log(`Dropped (noise):`);
  r.dropped.slice(0, 8).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
}

run('Policy Transaction Detail', parsePtd, PTD);
run('Pending Transactions Detail', parsePending, PENDING);
