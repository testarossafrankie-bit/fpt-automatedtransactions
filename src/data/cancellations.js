// Top-level tab structure for /tasks.
//
// Tab routing is driven by Transaction Type (EZLynx's clean label) + Policy
// Status. The old IVANS cycle-code buckets (XLC/XLP/XLN) are preserved on
// records for traceability but no longer drive UI routing.

import { TX_SAVE_QUEUE, TX_REWRITE } from '../lib/ezlynxReport.js';

export const TABS = [
  {
    key: 'save',
    label: 'Save Queue',
    color: 'bg-amber-100 text-amber-800 border-amber-300',
    description: 'Future-dated cancels still rescuable (Cancel Req + upcoming Cancel Confirmation)',
  },
  {
    key: 'cancelled',
    label: 'Already Cancelled',
    color: 'bg-red-100 text-red-800 border-red-300',
    description: 'Past-date cancels — audit + remarket workflow',
  },
  {
    key: 'rewrites',
    label: 'Rewrites',
    color: 'bg-slate-100 text-slate-700 border-slate-300',
    description: 'Auto-flagged rewrites — hidden from active queues',
  },
];

export const STATUSES = ['not_started', 'attempted', 'contacted', 'resolved', 'cancelled', 'rewrite'];

export function tabMeta(key) {
  return TABS.find(t => t.key === key) || TABS[0];
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// Which top-level tab does a record belong to?
// Rewrites first (always hidden). Then split cancels by whether the cancel
// has already effected: Cancel Confirmation + Inactive = past loss; everything
// else = still in Save Queue.
export function tabForRecord(r) {
  // Legacy IVANS records (pre-EZLynx-report migration) carry a bucket field.
  // Honor it so existing localStorage data still routes correctly.
  if (r.status === 'rewrite') return 'rewrites';
  if (r.rewriteLevel) return 'rewrites';
  if (r.transactionType) {
    if (TX_REWRITE.has(r.transactionType)) return 'rewrites';
    if (r.transactionType === 'Cancel Confirmation' && r.policyStatus === 'Inactive') return 'cancelled';
    if (r.transactionType === 'Cancel Confirmation' && r.cancelDate && r.cancelDate < todayIso()) return 'cancelled';
    if (TX_SAVE_QUEUE.has(r.transactionType)) return 'save';
    return 'save';
  }
  // Legacy IVANS-parser records: use bucket.
  if (r.bucket === 'cancelled') return 'cancelled';
  return 'save';
}

// Merge records that represent the same real-world cancellation event but
// come from different reports (PTD vs Pending Transactions). Key is
// (policyNumber + transactionType). On conflict, prefer the record with the
// filled cancelDate (Pending report wins), and prefer non-empty fields from
// either source.
export function mergeDuplicates(records) {
  const norm = s => String(s || '').replace(/\s+/g, '').toUpperCase();
  const merged = new Map();
  for (const r of records) {
    if (r.deleted) continue;
    const key = `${norm(r.policyNumber)}|${r.transactionType || r.cycle || ''}`;
    const prev = merged.get(key);
    if (!prev) { merged.set(key, r); continue; }
    merged.set(key, mergeRecordPair(prev, r));
  }
  // Pass through soft-deleted rows unchanged (so Deleted-only views still work).
  const kept = [...merged.values()];
  for (const r of records) if (r.deleted) kept.push(r);
  return kept;
}

function mergeRecordPair(a, b) {
  // Choose "primary" as the one with the filled cancelDate (Pending-sourced).
  const [primary, secondary] = (a.cancelDate && !b.cancelDate) ? [a, b]
                             : (!a.cancelDate && b.cancelDate) ? [b, a]
                             : (a.lastUpdated >= b.lastUpdated) ? [a, b] : [b, a];
  const merged = { ...primary };
  // Fill gaps from the other source.
  for (const k of Object.keys(secondary)) {
    const sv = secondary[k];
    const pv = merged[k];
    if ((pv === undefined || pv === null || pv === '' || pv === 0) && sv !== undefined && sv !== null && sv !== '') {
      merged[k] = sv;
    }
  }
  // Workflow fields (status/notes/assignedUser) always come from primary.
  return merged;
}
