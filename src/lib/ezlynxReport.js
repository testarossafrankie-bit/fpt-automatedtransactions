// Shared helpers for parsing EZLynx scheduled reports. Both PTD and
// Pending Transactions carry the same column prefix convention
// ("Policy Transaction Data X", "Applicant Data X") so the field pickers
// are reusable.

import { parseCsv } from './csv.js';

// Transaction type categories. These are the English labels EZLynx uses
// directly, so no cycle-code mapping needed.
export const TX_SAVE_QUEUE = new Set([
  'Cancel Req',           // XLP equivalent — pending cancel request
  'Cancel Confirmation',  // XLC equivalent — confirmed cancel (may be future-dated)
]);
export const TX_REWRITE = new Set(['Rewrite', 'Cancel Rewrite']);
export const TX_RESOLVE = new Set(['Reinstate']);
// Dropped at ingest — not cancel-related.
export const TX_NOISE = new Set([
  'Renewal', 'Renew Quote', 'Renewal Re-Quote', 'New Business',
  'Policy Change', 'Non-Renewal', 'Re-Issue', 'DB Synch',
]);

// Each field has multiple candidate column names because EZLynx CSV exports
// use "Policy Transaction Data X" prefixes while EZLynx JSON-Simple exports
// drop the prefix. We try each candidate in order. The en-dash in
// "Premium – Written" is intentional — matches EZLynx's JSON output.
const COLS = {
  customerName:      ['Applicant Data Account Name', 'Account Name'],
  policyNumber:      ['Policy Transaction Data Policy Number', 'Policy Number'],
  carrier:           ['Policy Transaction Data Master Company', 'Master Company'],
  LOB:               ['Policy Transaction Data Line Of Business', 'Line Of Business'],
  policyStatus:      ['Policy Transaction Data Current Policy Status', 'Current Policy Status'],
  policyDetailStatus:['Policy Transaction Data Policy Detail Status', 'Policy Detail Status'],
  transactionType:   ['Policy Transaction Data Transaction Type', 'Transaction Type'],
  effectiveDate:     ['Policy Transaction Data Effective Date', 'Effective Date'],
  expirationDate:    ['Policy Transaction Data Expiration Date', 'Expiration Date'],
  changeDate:        ['Policy Transaction Data Change Date', 'Change Date', 'Policy Transaction Data Cancellation Date', 'Cancellation Date', 'Cancel Date'],
  downloadDate:      ['Policy Transaction Data Download Date', 'Download Date'],
  annualizedPremium: ['Policy Transaction Data Annualized Premium', 'Annualized Premium'],
  writtenPremium:    ['Policy Transaction Data Written Premium', 'Written Premium', 'Premium – Written', 'Premium - Written'],
  branch:            ['Applicant Data Branch', 'Branch'],
  department:        ['Policy Transaction Data Department', 'Department'],
  serviceTeam:       ['Serviceteampolicychangerequest Service Team', 'Service Team'],
  assignedProducer:  ['Applicant Data Assigned Producer', 'Assigned Producer'],
  csr:               ['Applicant Data CSR', 'CSR'],
  applicantId:       ['Policy Transaction Data Applicant ID', 'Applicant ID'],
  policyId:          ['Policy Transaction Data Policy ID', 'Policy ID'],
  policyTransactionId:['Policy Transaction Data Policy Transaction ID', 'Policy Transaction ID'],
};

// Parse $-prefixed string → number. "$1,234.56" → 1234.56. Blank → 0.
export function toNumber(s) {
  if (!s) return 0;
  const n = Number(String(s).replace(/[$,]/g, '').trim());
  return isNaN(n) ? 0 : n;
}

// Accepts either:
//   - CSV text (string)
//   - Array of row objects (webhook JSON — each key = column name)
// Returns a normalized array of raw records with the fields we care about.
export function readReport(input) {
  if (typeof input === 'string') {
    const rows = parseCsv(input);
    if (!rows.length) return [];
    const h = rows[0];
    const idx = Object.fromEntries(h.map((x, i) => [String(x).trim(), i]));
    return rows.slice(1)
      .filter(r => r && r.length > 1 && r[0] !== '')
      .map(r => mapByIdx(r, idx));
  }
  if (Array.isArray(input)) {
    return input.map(o => mapByKey(o));
  }
  return [];
}

// Try each candidate column name in order; return first non-empty hit.
function pickIdx(candidates, idx, r) {
  for (const c of candidates) {
    if (idx[c] !== undefined) {
      const v = r[idx[c]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return '';
}
function pickKey(candidates, o) {
  for (const c of candidates) {
    const v = o[c];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

function mapByIdx(r, idx) {
  const g = (cols) => pickIdx(cols, idx, r);
  return {
    customerName:        g(COLS.customerName),
    policyNumber:        g(COLS.policyNumber),
    carrier:             g(COLS.carrier),
    LOB:                 g(COLS.LOB),
    policyStatus:        g(COLS.policyStatus),
    policyDetailStatus:  g(COLS.policyDetailStatus),
    transactionType:     g(COLS.transactionType),
    effectiveDate:       g(COLS.effectiveDate),
    expirationDate:      g(COLS.expirationDate),
    changeDate:          g(COLS.changeDate),
    downloadDate:        g(COLS.downloadDate),
    annualizedPremium:   toNumber(g(COLS.annualizedPremium)),
    writtenPremium:      toNumber(g(COLS.writtenPremium)),
    branch:              g(COLS.branch),
    department:          g(COLS.department),
    serviceTeam:         g(COLS.serviceTeam),
    assignedProducer:    g(COLS.assignedProducer),
    csr:                 g(COLS.csr),
    applicantId:         g(COLS.applicantId),
    policyId:            g(COLS.policyId),
    policyTransactionId: g(COLS.policyTransactionId),
  };
}

function mapByKey(o) {
  const g = (cols) => pickKey(cols, o);
  return {
    customerName:        g(COLS.customerName),
    policyNumber:        g(COLS.policyNumber),
    carrier:             g(COLS.carrier),
    LOB:                 g(COLS.LOB),
    policyStatus:        g(COLS.policyStatus),
    policyDetailStatus:  g(COLS.policyDetailStatus),
    transactionType:     g(COLS.transactionType),
    effectiveDate:       g(COLS.effectiveDate),
    expirationDate:      g(COLS.expirationDate),
    changeDate:          g(COLS.changeDate),
    downloadDate:        g(COLS.downloadDate),
    annualizedPremium:   toNumber(g(COLS.annualizedPremium)),
    writtenPremium:      toNumber(g(COLS.writtenPremium)),
    branch:              g(COLS.branch),
    department:          g(COLS.department),
    serviceTeam:         g(COLS.serviceTeam),
    assignedProducer:    g(COLS.assignedProducer),
    csr:                 g(COLS.csr),
    applicantId:         g(COLS.applicantId),
    policyId:            g(COLS.policyId),
    policyTransactionId: g(COLS.policyTransactionId),
  };
}

// Carrier name canonicalization. EZLynx shows "Progressive Insurance",
// our existing data uses "Progressive"; harmonize so the UI groups cleanly.
const CARRIER_ALIASES = {
  'Progressive Insurance': 'Progressive',
  'Safeco Insurance':      'Liberty Mutual',   // post-rebrand
  'Nationwide Insurance':  'Nationwide',
  'National General Ins Co.': 'National General',
  'MetLife Auto & Home®':  'Foremost Premier', // matches foremost_split memory
  'Capitol Insurance Company': 'Capitol',
};
export function normalizeCarrier(c) {
  if (!c) return 'Unknown';
  return CARRIER_ALIASES[c] || c;
}

// Build the canonical cancellation record from a raw EZLynx row.
export function toRecord(raw, source) {
  const nowIso = new Date().toISOString();
  const id = String(raw.policyTransactionId || `${raw.policyNumber}-${raw.transactionType}-${raw.changeDate || raw.downloadDate}`).trim();
  return {
    id,
    policyNumber:    raw.policyNumber,
    customerName:    raw.customerName,
    carrier:         normalizeCarrier(raw.carrier),
    carrierRaw:      raw.carrier,
    LOB:             raw.LOB,

    transactionType: raw.transactionType,
    policyStatus:    raw.policyStatus,
    cancelDate:      raw.changeDate || '',        // Pending reports: Change Date = cancel-effective
    effectiveDate:   raw.effectiveDate || '',
    expirationDate:  raw.expirationDate || '',
    downloadDate:    raw.downloadDate || '',

    annualizedPremium: raw.annualizedPremium,
    writtenPremium:    raw.writtenPremium,

    branch:            raw.branch,
    department:        raw.department,
    serviceTeam:       raw.serviceTeam,
    assignedProducer:  raw.assignedProducer,
    assignedCsr:       raw.csr,

    policyId:            raw.policyId,
    policyTransactionId: raw.policyTransactionId,
    applicantId:         raw.applicantId,

    // CSR workflow fields — start empty, owned by the UI thereafter.
    status:       'not_started',
    assignedUser: '',
    notes:        '',
    deleted:      false,

    source,
    createdAt:   nowIso,
    lastUpdated: nowIso,
  };
}
