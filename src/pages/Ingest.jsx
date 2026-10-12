import { useRef, useState } from 'react';
import { parsePtd } from '../parsers/ezlynxPtd.js';
import { parsePending } from '../parsers/ezlynxPending.js';
import { parseExport as parseIvans } from '../parsers/ezlynxIvans.js';
import { useCancellationData } from '../hooks/useCancellationData.js';
import { useSalesLog } from '../hooks/useSalesLog.js';
import { tabForRecord, mergeDuplicates } from '../data/cancellations.js';

// Detect which report a CSV came from by its header row.
// Returns 'ptd' | 'pending' | 'ivans-exportDetails' | null
function detectFormat(csvText) {
  const header = csvText.split(/\r?\n/)[0] || '';
  if (header.includes('Policy Transaction Data Change Date')) return 'pending';
  if (header.includes('Policy Transaction Data Transaction Type')) return 'ptd';
  if (header.includes('Cycle') && header.includes('From (Mailbox)')) return 'ivans-exportDetails';
  return null;
}

export default function Ingest() {
  const fileInput = useRef(null);
  const salesInput = useRef(null);
  const [preview, setPreview] = useState(null);
  const [commitResult, setCommitResult] = useState(null);
  const [error, setError] = useState('');
  const { upsertMany, applyResolves } = useCancellationData();
  const { salesLog, meta: salesMeta, importCsv: importSales, clear: clearSales, refreshFromPortal } = useSalesLog();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');

  const handleFile = async (file) => {
    setError('');
    setCommitResult(null);
    try {
      const text = await file.text();
      const format = detectFormat(text);
      if (!format) throw new Error('Unrecognized CSV format. Expected EZLynx Policy Transaction Detail, Pending Transactions Detail, or IVANS exportDetails.');

      let parsed, resolveEvents;
      if (format === 'ptd') {
        parsed = parsePtd(text, { salesLog });
        resolveEvents = parsed.resolves.map(r => ({ cycle: 'Reinstate', policyNum: r.policyNumber, txDate: r.resolvedDate, insured: r.customerName }));
      } else if (format === 'pending') {
        parsed = parsePending(text, { salesLog });
        resolveEvents = parsed.resolves.map(r => ({ cycle: 'Reinstate', policyNum: r.policyNumber, txDate: r.resolvedDate, insured: r.customerName }));
      } else {
        parsed = parseIvans(text, { salesLog });
        resolveEvents = parsed.resolves;
      }

      setPreview({ fileName: file.name, format, ...parsed, resolveEvents });
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const handleSales = async (file) => {
    setError('');
    try { importSales(await file.text(), file.name); }
    catch (e) { setError(`Sales CSV: ${e.message || String(e)}`); }
  };

  const onCommit = () => {
    if (!preview) return;
    const { added, updated } = upsertMany(preview.records);
    const { resolved } = applyResolves(preview.resolveEvents || []);
    setCommitResult({ added, updated, resolved });
  };

  const onReset = () => {
    setPreview(null); setCommitResult(null); setError('');
    if (fileInput.current) fileInput.current.value = '';
  };

  const isEzlynxReport = preview?.format === 'ptd' || preview?.format === 'pending';

  return (
    <div className="max-w-7xl mx-auto p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Ingest</h1>
        <p className="text-sm text-slate-500">
          Drop an EZLynx <b>Policy Transaction Detail</b> or <b>Pending Transactions Detail</b> CSV.
          Legacy IVANS exportDetails CSVs still work as fallback.
        </p>
      </header>

      {/* Sales log is only needed for the legacy IVANS format (heuristic rewrite detection).
          EZLynx reports carry explicit Rewrite / Cancel Rewrite labels so sales-log is unused. */}
      <SalesLogCard
        meta={salesMeta} salesCount={salesLog.length} inputRef={salesInput}
        onFile={handleSales} onClear={clearSales}
        onRefresh={async () => { setRefreshing(true); setRefreshError('');
          try { await refreshFromPortal(); } catch (e) { setRefreshError(e.message || String(e)); }
          finally { setRefreshing(false); }
        }}
        refreshing={refreshing} refreshError={refreshError}
      />

      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
        <div className="text-sm font-medium text-slate-900 mb-2">Cancellation report CSV</div>
        <div className="flex items-center gap-3">
          <input ref={fileInput} type="file" accept=".csv,text/csv"
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
            className="text-sm" />
          {preview && <button onClick={onReset} className="text-sm text-slate-500 hover:text-slate-900">clear</button>}
        </div>
        {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
      </div>

      {preview && (
        <>
          <SummaryCard preview={preview} commitResult={commitResult} onCommit={onCommit} />
          <TabTable title="Save Queue (future-dated cancels, still savable)" tab="save"      records={preview.records} />
          <TabTable title="Already Cancelled (past-date — audit / remarket)" tab="cancelled" records={preview.records} />
          <TabTable title="Rewrites (auto-flagged)"                           tab="rewrites"  records={preview.records} />
          {isEzlynxReport && <ResolveTable resolveEvents={preview.resolveEvents} />}
          {!isEzlynxReport && (
            <>
              <IvansResolveTable resolvedPairs={preview.resolvedPairs} unmatchedResolves={preview.unmatchedResolves} />
              <DroppedTable dropped={preview.dropped} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function SalesLogCard({ meta, salesCount, inputRef, onFile, onClear, onRefresh, refreshing, refreshError }) {
  const sourceLabel = meta?.source === 'portal' ? 'portal API' : meta?.fileName || 'CSV upload';
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 mb-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-slate-900">Sales log <span className="text-xs text-slate-500 font-normal">(only used for legacy IVANS exportDetails ingest)</span></div>
          {meta ? (
            <div className="text-xs text-slate-500 mt-1">
              {salesCount} sales rows from <span className="font-mono">{sourceLabel}</span>
              <span className="ml-2">· refreshed {new Date(meta.uploadedAt).toLocaleString()}</span>
            </div>
          ) : (
            <div className="text-xs text-slate-500 mt-1">Not loaded. Only needed if ingesting IVANS exportDetails CSVs.</div>
          )}
          {refreshError && <div className="text-xs text-red-600 mt-1">Refresh error: {refreshError}</div>}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={onRefresh} disabled={refreshing}
            className="text-sm bg-slate-100 hover:bg-slate-200 text-slate-800 rounded px-3 py-1 disabled:opacity-50">
            {refreshing ? 'Refreshing…' : 'Refresh from portal'}
          </button>
          <input ref={inputRef} type="file" accept=".csv,text/csv"
            onChange={e => e.target.files?.[0] && onFile(e.target.files[0])}
            className="text-sm" />
          {meta && <button onClick={onClear} className="text-sm text-slate-500 hover:text-red-600">clear</button>}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ preview, commitResult, onCommit }) {
  const merged = mergeDuplicates(preview.records);
  const counts = { save: 0, cancelled: 0, rewrites: 0 };
  for (const r of merged) counts[tabForRecord(r)]++;
  const formatLabel = {
    'ptd':      'Policy Transaction Detail',
    'pending':  'Pending Transactions Detail',
    'ivans-exportDetails': 'IVANS exportDetails (legacy)',
  }[preview.format] || preview.format;
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-sm text-slate-500 mb-2">
            <span className="font-mono">{preview.fileName}</span>
            <span className="ml-3 text-slate-700">· format: {formatLabel}</span>
          </div>
          <div className="flex gap-3 flex-wrap">
            <Stat label="Raw"            value={preview.rawCount} />
            <Stat label="Kept"           value={preview.records.length} />
            <Stat label="Save Queue"     value={counts.save}      tone="amber" />
            <Stat label="Already Cancel" value={counts.cancelled} tone="red" />
            <Stat label="Rewrites"       value={counts.rewrites}  tone="slate" />
            <Stat label="Resolves"       value={(preview.resolveEvents || []).length} />
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button onClick={onCommit} disabled={!!commitResult}
            className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-slate-800 disabled:opacity-50">
            {commitResult ? 'Committed' : 'Commit to tracker'}
          </button>
          {commitResult && (
            <div className="text-xs text-slate-600 text-right">
              {commitResult.added} new · {commitResult.updated} updated · {commitResult.resolved} resolved
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const toneCls =
    tone === 'red' ? 'text-red-700 bg-red-50' :
    tone === 'amber' ? 'text-amber-800 bg-amber-50' :
    tone === 'slate' ? 'text-slate-700 bg-slate-50' :
    'text-slate-700 bg-slate-50';
  return (
    <div className={`rounded-md px-3 py-2 ${toneCls}`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function TabTable({ title, tab, records }) {
  const merged = mergeDuplicates(records);
  const rows = merged.filter(r => tabForRecord(r) === tab)
    .sort((a, b) => (a.cancelDate || '').localeCompare(b.cancelDate || ''));
  const g = new Map();
  for (const r of rows) {
    const k = r.carrier || 'Unknown';
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const grouped = [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  return (
    <section className="bg-white border border-slate-200 rounded-xl mb-6 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-900">{title} <span className="text-slate-500 font-normal">({rows.length})</span></h2>
      </div>
      {!rows.length ? (
        <div className="p-5 text-sm text-slate-500">None.</div>
      ) : grouped.map(([carrier, list]) => (
        <div key={carrier}>
          <div className="px-5 py-2 bg-slate-50 text-xs font-semibold text-slate-700 border-t border-slate-100">
            {carrier} <span className="font-normal text-slate-500">({list.length})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2">Policy</th>
                  <th className="text-left px-4 py-2">Cancel Date</th>
                  <th className="text-left px-4 py-2">Customer</th>
                  <th className="text-left px-4 py-2">LOB</th>
                  <th className="text-left px-4 py-2">Tx Type</th>
                  <th className="text-left px-4 py-2">Premium</th>
                  <th className="text-left px-4 py-2">CSR</th>
                </tr>
              </thead>
              <tbody>
                {list.map(r => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono text-xs">{r.policyNumber}</td>
                    <td className="px-4 py-2">{r.cancelDate}</td>
                    <td className="px-4 py-2">{r.customerName}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{r.LOB}</td>
                    <td className="px-4 py-2 text-xs">{r.transactionType || r.cycle}</td>
                    <td className="px-4 py-2 text-xs">{r.annualizedPremium ? `$${r.annualizedPremium.toLocaleString()}` : ''}</td>
                    <td className="px-4 py-2 text-xs">{r.assignedCsr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

function ResolveTable({ resolveEvents }) {
  const list = resolveEvents || [];
  return (
    <section className="bg-white border border-slate-200 rounded-xl mb-6 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-900">Reinstatements (resolve prior cancels)</h2>
        <p className="text-xs text-slate-500 mt-0.5">On commit, each Reinstate matches the most recent open cancel for the same policy and marks it resolved.</p>
      </div>
      <div className="p-5">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Reinstate events ({list.length})</div>
        {!list.length ? <div className="text-sm text-slate-500">None.</div> : (
          <ul className="text-sm space-y-1">
            {list.slice(0, 50).map((r, i) => (
              <li key={i} className="font-mono text-xs">
                {r.policyNum} — Reinstate on {r.txDate} <span className="text-slate-500">({r.insured})</span>
              </li>
            ))}
            {list.length > 50 && <li className="text-xs text-slate-500">… and {list.length - 50} more</li>}
          </ul>
        )}
      </div>
    </section>
  );
}

function IvansResolveTable({ resolvedPairs, unmatchedResolves }) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl mb-6 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-900">Reinstatements / Rescissions (legacy IVANS)</h2>
      </div>
      <div className="p-5 grid md:grid-cols-2 gap-6">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">In-batch ({resolvedPairs?.length || 0})</div>
          {!resolvedPairs?.length ? <div className="text-sm text-slate-500">None.</div> : (
            <ul className="text-sm space-y-1">
              {resolvedPairs.map(({ prior, resolver }) => (
                <li key={prior.id} className="font-mono text-xs">
                  {prior.policyNumber} — {prior.cycle} {prior.cancelDate} → {resolver.cycle} {resolver.txDate}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Unmatched ({unmatchedResolves?.length || 0})</div>
          {!unmatchedResolves?.length ? <div className="text-sm text-slate-500">None.</div> : (
            <ul className="text-sm space-y-1">
              {unmatchedResolves.map(r => (
                <li key={`${r.policyNum}-${r.cycle}-${r.txDate}`} className="font-mono text-xs">
                  {r.policyNum} — {r.cycle} {r.txDate}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function DroppedTable({ dropped }) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl mb-6 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-900">Dropped (non-cancellation cycles)</h2>
      </div>
      <div className="p-5">
        <div className="flex flex-wrap gap-2 text-xs">
          {dropped.map(([cycle, n]) => (
            <span key={cycle} className="bg-slate-100 text-slate-700 rounded px-2 py-1 font-mono">
              {cycle}: {n}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
