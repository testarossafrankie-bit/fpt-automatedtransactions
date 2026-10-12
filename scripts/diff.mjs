// Diff IVANS tracker (parsed from exportDetails CSV) against portal
// cancellation exports. Both sides keyed by normalized policyNumber.
import fs from 'node:fs';
import { parseExport } from '../src/parsers/ezlynxIvans.js';
import { parseCsv } from '../src/lib/csv.js';

const IVANS = 'C:/Users/fterr/Downloads/exportDetails_20261009110533.csv';
const PORTAL_FILES = {
  active:        'C:/Users/fterr/Downloads/cancellations_export_2026-10-09.csv',
  fullHistory:   'C:/Users/fterr/Downloads/cancellations_export_2026-10-09 (1).csv',
  cancelledOnly: 'C:/Users/fterr/Downloads/cancellations_export_2026-10-09 (3).csv',
};

const norm = s => String(s || '').replace(/\s+/g, '').toUpperCase();

function readPortal(path) {
  const rows = parseCsv(fs.readFileSync(path, 'utf8'));
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return rows.slice(1).filter(r => r.length > 1 && r[0] !== '').map(r => ({
    policyNumber: r[idx['Policy Number']],
    customerName: r[idx['Customer']],
    carrier:      r[idx['Carrier']],
    cancelReason: r[idx['Cancel Reason']],
    cancelDate:   r[idx['Cancel Date']],
    amountDue:    r[idx['Amount Due']],
    status:       r[idx['Status']],
    assignedTo:   r[idx['Assigned To']],
    notes:        r[idx['Notes']],
  }));
}

// IVANS side — all cancellations in the batch, parser-normalized.
const ivansText = fs.readFileSync(IVANS, 'utf8');
const parsed = parseExport(ivansText);
const ivansRecords = parsed.records;
const ivansByPolicy = new Map();
for (const r of ivansRecords) {
  const k = norm(r.policyNumber);
  if (!ivansByPolicy.has(k)) ivansByPolicy.set(k, []);
  ivansByPolicy.get(k).push(r);
}

for (const [name, path] of Object.entries(PORTAL_FILES)) {
  const portal = readPortal(path);
  const portalByPolicy = new Map(portal.map(r => [norm(r.policyNumber), r]));

  const both = portal.filter(r => ivansByPolicy.has(norm(r.policyNumber)));
  const portalOnly = portal.filter(r => !ivansByPolicy.has(norm(r.policyNumber)));
  const ivansOnly = ivansRecords.filter(r => !portalByPolicy.has(norm(r.policyNumber)));

  console.log(`\n==========================================`);
  console.log(`PORTAL FILE: ${name}  (${portal.length} rows)`);
  console.log(`IVANS batch:  ${ivansRecords.length} records`);
  console.log(`In both:      ${both.length}`);
  console.log(`Portal-only:  ${portalOnly.length}`);
  console.log(`IVANS-only:   ${ivansOnly.length}`);
  console.log(`==========================================\n`);

  if (name === 'active') {
    console.log('--- IVANS-only (CSRs may not have logged these yet) ---');
    ivansOnly
      .sort((a, b) => (a.cancelDate || '').localeCompare(b.cancelDate || ''))
      .forEach(r => console.log(`  ${r.policyNumber.padEnd(18)} ${r.carrier.padEnd(16)} ${r.cancelDate}  ${r.bucket.padEnd(12)} ${r.customerName}`));

    console.log('\n--- Portal-only (CSRs logged, IVANS batch doesn\'t cover) ---');
    portalOnly
      .sort((a, b) => (a.cancelDate || '').localeCompare(b.cancelDate || ''))
      .forEach(r => console.log(`  ${(r.policyNumber || '').padEnd(18)} ${(r.carrier || '').padEnd(16)} ${(r.cancelDate || '').padEnd(10)}  ${(r.status || '').padEnd(12)} ${r.customerName}`));
  }
}
