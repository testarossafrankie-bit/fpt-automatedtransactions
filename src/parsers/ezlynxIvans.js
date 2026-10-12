// Phase-1 parser for EZLynx IVANS "exportDetails" CSV.
// Reads one export → returns:
//   { kept, resolves, resolvedPairs, unmatchedResolves, dropped }
//
// kept[] are the normalized cancellation records (bucket-tagged) ready to
// write to KV. resolves[] carry REI/RSN rows that resolve prior open records.
//
// Carrier mapping is intentionally conservative: codes we're sure of map to
// the full carrier name; anything unverified passes through so Frank can
// decode it from the UI and tell us what it is.

import { parseCsv } from '../lib/csv.js';
import { classifyRewrite, prepareSalesIndex, prepareNbsIndex } from '../lib/rewriteClassifier.js';

const BUCKET = {
  CANCELLED:   'cancelled',
  PENDING:     'pending',
  UNPAID_BILL: 'unpaid_bill',
};

const RESOLVE_CYCLES = new Set(['REI', 'RSN']);

// From-mailbox → canonical carrier name. Only codes Frank has verified.
// Unknowns pass through as-is.
const MAILBOX_TO_CARRIER = {
  PRCE: 'Progressive',
  SAFC: 'Liberty Mutual',   // post-rebrand (safeco_liberty_rename)
  AGIS: 'Nationwide',
  IVAG: 'Travelers',
  GENS: 'Geico',
  INT1: 'National General',
  bwig: 'Bristol West',
  MEPR: 'Foremost Premier',   // MetLife Auto & Home. Post-9/26 Foremost
                              // split routes MetLife bindings into the
                              // Foremost Premier bucket (see foremost_split).
};

function carrierFromMailbox(code) {
  return MAILBOX_TO_CARRIER[code] || code || 'Unknown';
}

// M/D/YYYY → YYYY-MM-DD (ISO). Blank → ''.
export function toIso(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return s;
  const mm = String(m[1]).padStart(2, '0');
  const dd = String(m[2]).padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

// ISO date → sort key YYYYMMDD. Blank → 0.
export function dateKey(iso) {
  if (!iso) return 0;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function rowToTx(r) {
  return {
    fileName:     r[0],
    fileId:       r[1],
    rowId:        r[2],
    dateSent:     toIso(r[3]),
    dateReceived: toIso(r[4]),
    fromMailbox:  r[5],
    fromName:     r[6],
    toMailbox:    r[7],
    toName:       r[8],
    policyNum:    r[9],
    agencyCode:   r[10],
    insured:      r[11],
    effDate:      toIso(r[12]),
    expDate:      toIso(r[13]),
    txDate:       toIso(r[14]),
    LOB:          r[18],
    cycle:        r[19],
    downloadType: r[22],
  };
}

export function bucketOf(tx) {
  const c = tx.cycle;
  if (c === 'XLP') return BUCKET.PENDING;
  if (c === 'XLN') return BUCKET.UNPAID_BILL;
  if (c === 'XLC') return dateKey(tx.txDate) > todayKey() ? BUCKET.PENDING : BUCKET.CANCELLED;
  if (RESOLVE_CYCLES.has(c)) return 'resolve_prior';
  return null;
}

// Normalized record shape — mirrors portal `cancellations` + IVANS extras.
// Fields CSRs fill in (status/assignedUser/notes/cancelReason) start blank
// and are owned by the UI layer thereafter.
function toRecord(tx, bucket) {
  const nowIso = new Date().toISOString();
  const id = `${tx.policyNum}|${tx.cycle}|${tx.txDate}`.replace(/\s+/g, '_');
  return {
    id,
    policyNumber: tx.policyNum,
    customerName: tx.insured,
    carrier:      carrierFromMailbox(tx.fromMailbox),
    cancelReason: tx.cycle === 'XLN' ? 'Billing' : '',
    cancelDate:   tx.txDate,
    amountDue:    '',
    assignedUser: '',
    notes:        '',
    status:       'not_started',
    deleted:      false,

    // IVANS-specific traceability
    bucket,
    cycle:        tx.cycle,
    LOB:          tx.LOB,
    effDate:      tx.effDate,
    expDate:      tx.expDate,
    fromMailbox:  tx.fromMailbox,
    agencyCode:   tx.agencyCode,
    rawTxId:      tx.fileId,
    source:       'ivans-ezlynx',

    // Rewrite tag — filled in by classifier pass after records are built.
    rewriteLevel: '',
    newPolicy:    '',
    newCarrier:   '',
    newBindDate:  '',
    deltaDays:    '',
    rewriteAgent: '',

    createdAt:    nowIso,
    lastUpdated:  nowIso,
  };
}

export function parseExport(csvText, { salesLog = [] } = {}) {
  const rows = parseCsv(csvText);
  const data = rows.slice(1).filter(r => r && r.length > 1 && r[0] !== '');
  const txs = data.map(rowToTx);

  const kept = [];
  const resolves = [];
  const nbsBatch = [];
  const dropped = new Map();

  for (const tx of txs) {
    // Capture NBS rows for rewrite detection fallback (parser otherwise drops).
    if (tx.cycle === 'NBS') {
      nbsBatch.push({
        policyNumber: tx.policyNum,
        carrier:      carrierFromMailbox(tx.fromMailbox),
        insured:      tx.insured,
        date:         tx.txDate || tx.effDate,
      });
    }
    const b = bucketOf(tx);
    if (b === 'resolve_prior') { resolves.push(tx); continue; }
    if (b) kept.push({ tx, bucket: b });
    else {
      const k = tx.cycle || '(blank)';
      dropped.set(k, (dropped.get(k) || 0) + 1);
    }
  }

  // Dedupe kept: within same (policyNum, cycle), latest txDate wins.
  const bestByKey = new Map();
  for (const { tx, bucket } of kept) {
    const key = `${tx.policyNum}|${tx.cycle}`;
    const prev = bestByKey.get(key);
    if (!prev || dateKey(tx.txDate) > dateKey(prev.tx.txDate)) {
      bestByKey.set(key, { tx, bucket });
    }
  }
  const deduped = [...bestByKey.values()];

  // Build records (not yet resolved).
  const records = deduped.map(({ tx, bucket }) => toRecord(tx, bucket));

  // Apply REI/RSN resolves against records in this batch.
  const openByPolicy = new Map();
  for (const r of records) {
    const list = openByPolicy.get(r.policyNumber) || [];
    list.push(r);
    openByPolicy.set(r.policyNumber, list);
  }
  const resolvedPairs = [];
  const unmatchedResolves = [];
  for (const r of resolves) {
    const list = openByPolicy.get(r.policyNum);
    if (!list || !list.length) { unmatchedResolves.push(r); continue; }
    list.sort((a, b) => dateKey(b.cancelDate) - dateKey(a.cancelDate));
    const target = list[0];
    if (target.status !== 'resolved') {
      target.status = 'resolved';
      target.resolvedBy = r.cycle;
      target.resolvedDate = r.txDate;
      resolvedPairs.push({ prior: target, resolver: r });
    }
  }

  // Rewrite classification pass. Runs after records are built so we have
  // access to the full batch's NBS entries and the externally-supplied
  // sales log.
  const salesIndex = prepareSalesIndex(salesLog);
  const nbsIndex = prepareNbsIndex(nbsBatch);
  const rewriteCounts = { STRONG: 0, LIKELY: 0, NBS_ONLY: 0 };
  for (const r of records) {
    const rw = classifyRewrite(r, { salesIndex, nbsIndex });
    if (!rw) continue;
    r.rewriteLevel = rw.level;
    r.newPolicy    = rw.newPolicy;
    r.newCarrier   = rw.newCarrier;
    r.newBindDate  = rw.newBindDate;
    r.deltaDays    = rw.deltaDays;
    r.rewriteAgent = rw.rewriteAgent;
    rewriteCounts[rw.level]++;
  }

  return {
    records,
    resolves,
    resolvedPairs,
    unmatchedResolves,
    dropped: [...dropped.entries()].sort((a, b) => b[1] - a[1]),
    rawCount: txs.length,
    rewriteCounts,
    salesLogSize: salesIndex.length,
  };
}

export { BUCKET };
