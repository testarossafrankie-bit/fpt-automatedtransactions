import { useCancellationData } from '../hooks/useCancellationData.js';

// Small nav-bar indicator so you can tell at a glance whether the app is
// talking to KV (production) or sitting on localStorage (dev/no-KV).
export default function SyncBadge() {
  const { mode, syncStatus, clearAll } = useCancellationData();

  const label =
    mode === 'local'      ? 'local'
    : syncStatus === 'loading' ? 'syncing…'
    : syncStatus === 'error'   ? 'sync error'
    : 'synced';
  const color =
    mode === 'local'      ? 'bg-amber-500/20 text-amber-200'
    : syncStatus === 'error' ? 'bg-red-500/20 text-red-200'
    : syncStatus === 'loading' ? 'bg-slate-500/20 text-slate-200'
    : 'bg-emerald-500/20 text-emerald-200';

  const onClear = () => {
    if (!confirm('Clear ALL cancellation records? This cannot be undone.')) return;
    clearAll();
  };

  return (
    <span className="flex items-center gap-2">
      <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${color}`} title={`mode=${mode} status=${syncStatus}`}>
        {label}
      </span>
      <button
        onClick={onClear}
        className="text-[10px] text-slate-500 hover:text-red-400"
        title="Nuke local + remote tracker data (admin)"
      >clear data</button>
    </span>
  );
}
