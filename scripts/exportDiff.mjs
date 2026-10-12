// Full-list diff IVANS tracker vs portal /tasks, cancelDate >= 2026-09-01.
// Writes two CSVs to Downloads:
//   ivans_only_since_2026-09-01.csv       — IVANS records portal doesn't have
//   dashboard_only_since_2026-09-01.csv   — portal records IVANS doesn't have

import fs from 'node:fs';
import { parseExport } from '../src/parsers/ezlynxIvans.js';
import { parseCsv } from '../src/lib/csv.js';

const SINCE = '2026-09-01';
const IVANS_CSV      = 'C:/Users/fterr/Downloads/exportDetails_20261009110533.csv';
const PORTAL_CSV     = 'C:/Users/fterr/Downloads/cancellations_export_2026-10-09 (1).csv';
const OUT_IVANS_ONLY = 'C:/Users/fterr/Downloads/ivans_only_since_2026-09-01.csv';
const OUT_PORTAL_ONLY= 'C:/Users/fterr/Downloads/dashboard_only_since_2026-09-01.csv';

const norm = s => String(s || '').replace(/\s+/g, '').toUpperCase();

// Robust date → ISO. Accepts M/D/YYYY, MM/DD/YYYY, YYYY-MM-DD. Blank → ''.
function toIso(s) {
  if (!s) return '';
  const t = String(s).trim();
  const slash = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2,'0')}-${slash[2].padStart(2,'0')}`;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return t;
  return '';
}

// --- Portal side ---
const portalRows = parseCsv(fs.readFileSync(PORTAL_CSV, 'utf8'));
const header = portalRows[0];
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const portal = portalRows.slice(1)
  .filter(r => r.length > 1 && r[0] !== '')
  .map(r => ({
    policyNumber: r[idx['Policy Number']],
    customerName: r[idx['Customer']],
    carrier:      r[idx['Carrier']],
    cancelReason: r[idx['Cancel Reason']],
    cancelDate:   toIso(r[idx['Cancel Date']]),
    cancelDateRaw: r[idx['Cancel Date']],
    amountDue:    r[idx['Amount Due']],
    status:       r[idx['Status']],
    assignedTo:   r[idx['Assigned To']],
    notes:        r[idx['Notes']],
  }))
  .filter(r => r.cancelDate >= SINCE);

const portalByPolicy = new Map(portal.map(r => [norm(r.policyNumber), r]));

// --- IVANS side ---
const parsed = parseExport(fs.readFileSync(IVANS_CSV, 'utf8'));
const ivans = parsed.records.filter(r => (r.cancelDate || '') >= SINCE);
const ivansByPolicy = new Map();
for (const r of ivans) {
  const k = norm(r.policyNumber);
  if (!ivansByPolicy.has(k)) ivansByPolicy.set(k, []);
  ivansByPolicy.get(k).push(r);
}

const ivansOnly = ivans.filter(r => !portalByPolicy.has(norm(r.policyNumber)));
const portalOnly = portal.filter(r => !ivansByPolicy.has(norm(r.policyNumber)));

// --- CSV writers ---
function esc(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}
function toCsv(headers, rows) {
  const h = headers.map(esc).join(',');
  const body = rows.map(r => headers.map(k => esc(r[k])).join(',')).join('\n');
  return h + '\n' + body + '\n';
}

const ivansOnlyCsv = toCsv(
  ['policyNumber','carrier','customerName','cancelDate','bucket','cycle','status','resolvedBy','LOB','fromMailbox'],
  ivansOnly.map(r => ({
    policyNumber: r.policyNumber,
    carrier: r.carrier,
    customerName: r.customerName,
    cancelDate: r.cancelDate,
    bucket: r.bucket,
    cycle: r.cycle,
    status: r.status,
    resolvedBy: r.resolvedBy || '',
    LOB: r.LOB,
    fromMailbox: r.fromMailbox,
  })).sort((a, b) => (a.cancelDate || '').localeCompare(b.cancelDate || ''))
);

const portalOnlyCsv = toCsv(
  ['policyNumber','carrier','customerName','cancelDate','cancelReason','amountDue','status','assignedTo','notes'],
  portalOnly.map(r => ({
    policyNumber: r.policyNumber,
    carrier: r.carrier,
    customerName: r.customerName,
    cancelDate: r.cancelDate,
    cancelReason: r.cancelReason,
    amountDue: r.amountDue,
    status: r.status,
    assignedTo: r.assignedTo,
    notes: r.notes,
  })).sort((a, b) => (a.cancelDate || '').localeCompare(b.cancelDate || ''))
);

fs.writeFileSync(OUT_IVANS_ONLY, ivansOnlyCsv);
fs.writeFileSync(OUT_PORTAL_ONLY, portalOnlyCsv);

console.log(`Window: cancelDate >= ${SINCE}`);
console.log(`Portal records in window: ${portal.length}`);
console.log(`IVANS records in window:  ${ivans.length}`);
console.log(`In both:                  ${portal.length - portalOnly.length}`);
console.log(`\nIVANS-only:    ${ivansOnly.length}  → ${OUT_IVANS_ONLY}`);
console.log(`Dashboard-only: ${portalOnly.length} → ${OUT_PORTAL_ONLY}`);
