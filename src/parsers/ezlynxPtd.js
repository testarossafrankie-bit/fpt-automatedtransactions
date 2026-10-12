// Parse the EZLynx "Policy Transaction Detail" report.
// Primary source for: Already Cancelled, Rewrites, Reinstate resolve events.
//
// Input: CSV text OR array of JSON objects (webhook).
// Opts:  { salesLog } — enables cross-carrier rewrite detection for
//        Cancel Confirmation / Cancel Req rows EZLynx didn't auto-tag as
//        "Cancel Rewrite" (e.g. LM → Foremost Premier Exner case).
// Output: { records, resolves, dropped, rewriteCount, rawCount }

import { readReport, toRecord, TX_SAVE_QUEUE, TX_REWRITE, TX_RESOLVE } from '../lib/ezlynxReport.js';
import { classifyRewrite, prepareSalesIndex } from '../lib/rewriteClassifier.js';

export function parsePtd(input, { salesLog = [] } = {}) {
  const raw = readReport(input);
  const records = [];
  const resolves = [];
  const dropped = new Map();

  for (const r of raw) {
    const t = r.transactionType;
    if (!t) { dropped.set('(blank)', (dropped.get('(blank)') || 0) + 1); continue; }

    if (TX_RESOLVE.has(t)) {
      resolves.push({
        policyNumber: r.policyNumber,
        customerName: r.customerName,
        transactionType: t,
        resolvedDate: r.changeDate || r.effectiveDate || r.downloadDate,
        policyTransactionId: r.policyTransactionId,
      });
      continue;
    }

    if (TX_SAVE_QUEUE.has(t) || TX_REWRITE.has(t)) {
      records.push(toRecord(r, 'ezlynx-ptd'));
      continue;
    }

    // Everything else — Renewal / New Business / Policy Change / Re-Issue /
    // DB Synch — not cancellation-related.
    dropped.set(t, (dropped.get(t) || 0) + 1);
  }

  // Cross-carrier rewrite detection via sales-log cross-reference. EZLynx
  // auto-tags same-carrier rewrites but misses cross-carrier ones (e.g.
  // Liberty Mutual → Foremost Premier). Classifier fills the gap.
  const salesIndex = prepareSalesIndex(salesLog);
  for (const rec of records) {
    if (TX_REWRITE.has(rec.transactionType)) continue; // already labeled
    const rw = classifyRewrite(rec, { salesIndex, nbsIndex: [] });
    if (!rw) continue;
    rec.rewriteLevel = rw.level;
    rec.newPolicy    = rw.newPolicy;
    rec.newCarrier   = rw.newCarrier;
    rec.newBindDate  = rw.newBindDate;
    rec.deltaDays    = rw.deltaDays;
    rec.rewriteAgent = rw.rewriteAgent;
  }

  const rewriteCount = records.filter(r => TX_REWRITE.has(r.transactionType) || r.rewriteLevel).length;

  return {
    records,
    resolves,
    dropped: [...dropped.entries()].sort((a, b) => b[1] - a[1]),
    rewriteCount,
    rawCount: raw.length,
  };
}
