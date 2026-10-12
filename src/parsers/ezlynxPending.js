// Parse the EZLynx "Pending Transactions Detail" report.
// Primary source for: Save Queue (future-dated cancels still rescuable).
//
// Change Date carries the cancel-effective date — the field we needed and
// didn't have in Policy Transaction Detail.

import { readReport, toRecord, TX_SAVE_QUEUE, TX_REWRITE, TX_RESOLVE } from '../lib/ezlynxReport.js';
import { classifyRewrite, prepareSalesIndex } from '../lib/rewriteClassifier.js';

export function parsePending(input, { salesLog = [] } = {}) {
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
      records.push(toRecord(r, 'ezlynx-pending'));
      continue;
    }

    // Pending report has lots of Renewal / Renew Quote / New Business noise.
    dropped.set(t, (dropped.get(t) || 0) + 1);
  }

  // Cross-carrier rewrite detection — same as PTD.
  const salesIndex = prepareSalesIndex(salesLog);
  for (const rec of records) {
    if (TX_REWRITE.has(rec.transactionType)) continue;
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
