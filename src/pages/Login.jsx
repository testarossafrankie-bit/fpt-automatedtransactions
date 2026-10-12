import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';

export default function Login() {
  const { login, user } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  if (user) {
    nav('/tasks', { replace: true });
    return null;
  }

  const submit = (e) => {
    e.preventDefault();
    const r = login(name, password);
    if (!r.ok) { setErr(r.error); return; }
    nav('/tasks', { replace: true });
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <form onSubmit={submit} className="bg-white rounded-xl shadow border border-slate-200 p-6 w-full max-w-sm">
        <h1 className="text-xl font-semibold text-slate-900 mb-1">IVANS Cancellation Tracker</h1>
        <p className="text-sm text-slate-500 mb-6">Sign in to continue</p>
        <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full border border-slate-300 rounded-md px-3 py-2 mb-3 text-sm"
          placeholder="Frank Terragrossa"
        />
        <label className="block text-sm font-medium text-slate-700 mb-1">Password <span className="text-slate-400 font-normal">(optional)</span></label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full border border-slate-300 rounded-md px-3 py-2 mb-4 text-sm"
        />
        {err && <div className="text-sm text-red-600 mb-3">{err}</div>}
        <button
          type="submit"
          className="w-full bg-slate-900 text-white rounded-md py-2 text-sm font-medium hover:bg-slate-800"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
