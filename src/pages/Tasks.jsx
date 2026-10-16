import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCancellationData } from '../hooks/useCancellationData.js';
import { TABS, STATUSES, tabMeta, tabForRecord, mergeDuplicates } from '../data/cancellations.js';

const ACTIVE_STATUSES = new Set(['not_started', 'attempted', 'contacted']);

export default function Tasks() {
  const { records, updateOne, softDelete } = useCancellationData();
  const [tab, setTab] = useState('save');
  const [activeFilter, setActiveFilter] = useState('active');  // active / resolved / all
  const [search, setSearch] = useState('');
  const [carrierFilter, setCarrierFilter] = useState('');

  // Merge PTD + Pending duplicates (same policy + same transaction type)
  // then partition. Also catches legacy IVANS rows merging against the
  // same-policy new-schema rows.
  const partitioned = useMemo(() => {
    const merged = mergeDuplicates(records);
    const o = { save: [], cancelled: [], rewrites: [] };
    for (const r of merged) {
      if (r.deleted) continue;
      o[tabForRecord(r)].push(r);
    }
    return o;
  }, [records]);

  const counts = useMemo(() => ({
    save:      partitioned.save.filter(r => ACTIVE_STATUSES.has(r.status)).length,
    cancelled: partitioned.cancelled.length,
    rewrites:  partitioned.rewrites.length,
  }), [partitioned]);

  const carriers = useMemo(() => {
    const set = new Set(partitioned[tab].map(r => r.carrier).filter(Boolean));
    return [...set].sort();
  }, [partitioned, tab]);

  const filtered = useMemo(() => {
    return partitioned[tab]
      .filter(r => {
        if (tab === 'rewrites') return true;
        if (activeFilter === 'active')   return ACTIVE_STATUSES.has(r.status);
        if (activeFilter === 'resolved') return r.status === 'resolved';
        return true;
      })
      .filter(r => !carrierFilter || r.carrier === carrierFilter)
      .filter(r => {
        if (!search) return true;
        const s = search.toLowerCase();
        return (r.policyNumber || '').toLowerCase().includes(s)
            || (r.customerName || '').toLowerCase().includes(s);
      })
      .sort((a, b) => (a.cancelDate || '').localeCompare(b.cancelDate || ''));
  }, [partitioned, tab, activeFilter, search, carrierFilter]);

  // Group by carrier within the tab, since CSRs are assigned by carrier.
  const grouped = useMemo(() => {
    const g = new Map();
    for (const r of filtered) {
      const key = r.carrier || 'Unknown';
      if (!g.has(key)) g.set(key, []);
      g.get(key).push(r);
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="max-w-7xl mx-auto p-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Cancellation Tasks</h1>
          <p className="text-sm text-slate-500">{tabMeta(tab).description}</p>
        </div>
        <Link
          to="/ingest"
          className="bg-slate-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-slate-800 whitespace-nowrap"
        >
          + Ingest IVANS file
        </Link>
      </header>

      <div className="flex gap-2 mb-4">
        {TABS.map(t => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 rounded-md text-sm font-medium border ${active ? t.color + ' border-current' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
            >
              {t.label} ({counts[t.key]})
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 mb-4 text-sm flex-wrap">
        {tab !== 'rewrites' && (
          <div className="inline-flex rounded-md border border-slate-200 bg-white overflow-hidden">
            {['active', 'resolved', 'all'].map(t => (
              <button
                key={t}
                onClick={() => setActiveFilter(t)}
                className={`px-3 py-1.5 ${activeFilter === t ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50'}`}
              >{t}</button>
            ))}
          </div>
        )}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search policy # or customer"
          className="border border-slate-200 rounded-md px-3 py-1.5 text-sm w-64"
        />
        <select
          value={carrierFilter}
          onChange={e => setCarrierFilter(e.target.value)}
          className="border border-slate-200 rounded-md px-3 py-1.5 text-sm"
        >
          <option value="">All carriers</option>
          {carriers.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {!filtered.length ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <p className="text-sm text-slate-500 mb-4">
            {tab === 'rewrites' ? 'No rewrites flagged in current records.' : 'Nothing here. Drop an EZLynx IVANS export on /ingest.'}
          </p>
          <Link
            to="/ingest"
            className="inline-block bg-slate-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-slate-800"
          >
            Go to Ingest →
          </Link>
        </div>
      ) : (
        grouped.map(([carrier, rows]) => (
          <CarrierSection
            key={carrier}
            tab={tab}
            carrier={carrier}
            rows={rows}
            updateOne={updateOne}
            softDelete={softDelete}
          />
        ))
      )}
    </div>
  );
}

function CarrierSection({ tab, carrier, rows, updateOne, softDelete }) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl mb-5 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-3 bg-slate-50">
        <h2 className="text-sm font-semibold text-slate-900">{carrier}</h2>
        <span className="text-xs text-slate-500">({rows.length})</span>
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
              {tab === 'rewrites' && (
                <>
                  <th className="text-left px-4 py-2">Rewrote To</th>
                  <th className="text-left px-4 py-2">By Agent</th>
                  <th className="text-left px-4 py-2">Tier</th>
                </>
              )}
              {tab !== 'rewrites' && (
                <>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Notes</th>
                </>
              )}
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-mono text-xs">{r.policyNumber}</td>
                <td className="px-4 py-2">{r.cancelDate}</td>
                <td className="px-4 py-2">{r.customerName}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{r.LOB}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{r.transactionType || r.cycle}</td>
                <td className="px-4 py-2 text-xs">{r.annualizedPremium ? `$${r.annualizedPremium.toLocaleString()}` : ''}</td>
                <td className="px-4 py-2 text-xs">{r.assignedCsr || ''}</td>
                {tab === 'rewrites' && (
                  <>
                    <td className="px-4 py-2 text-xs">
                      {r.newCarrier && <span className="font-medium">{r.newCarrier}</span>}
                      {r.newPolicy && <span className="font-mono text-slate-500 ml-1">· {r.newPolicy}</span>}
                      {r.newBindDate && <span className="text-slate-500 ml-1">· {r.newBindDate}</span>}
                    </td>
                    <td className="px-4 py-2 text-xs">{r.rewriteAgent}</td>
                    <td className="px-4 py-2 text-xs">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        r.rewriteLevel === 'STRONG' ? 'bg-emerald-100 text-emerald-800' :
                        r.rewriteLevel === 'LIKELY' ? 'bg-amber-100 text-amber-800' :
                        r.status === 'rewrite' ? 'bg-sky-100 text-sky-800' :
                        'bg-slate-100 text-slate-700'
                      }`}>{r.rewriteLevel || (r.status === 'rewrite' ? 'MANUAL' : '')}</span>
                      <button
                        onClick={() => updateOne(r.id, { rewriteLevel: '', overrideRewrite: true, status: r.status === 'rewrite' ? 'not_started' : r.status })}
                        className="ml-2 text-slate-400 hover:text-slate-700 text-xs"
                        title="Not a rewrite — move back to Save Queue"
                      >not a rewrite?</button>
                    </td>
                  </>
                )}
                {tab !== 'rewrites' && (
                  <>
                    <td className="px-4 py-2">
                      <select
                        value={r.status}
                        onChange={e => updateOne(r.id, { status: e.target.value })}
                        className="border border-slate-200 rounded px-2 py-1 text-xs"
                      >
                        {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="text"
                        defaultValue={r.notes}
                        onBlur={e => { if (e.target.value !== r.notes) updateOne(r.id, { notes: e.target.value }); }}
                        placeholder="…"
                        className="border border-slate-200 rounded px-2 py-1 text-xs w-full"
                      />
                    </td>
                  </>
                )}
                <td className="px-2 py-2 text-right">
                  <button
                    onClick={() => { if (confirm('Soft-delete this record?')) softDelete(r.id); }}
                    className="text-slate-400 hover:text-red-600 text-xs"
                    title="Soft delete"
                  >×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
