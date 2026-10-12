import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Ingest from './pages/Ingest.jsx';
import Tasks from './pages/Tasks.jsx';
import Footer from './components/Footer.jsx';
import SyncBadge from './components/SyncBadge.jsx';
import { useAuth } from './hooks/useAuth.js';

function Nav() {
  const { user, logout } = useAuth();
  if (!user) return null;
  const linkCls = ({ isActive }) =>
    `px-3 py-2 text-sm font-medium rounded-md ${isActive ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`;
  return (
    <nav className="bg-slate-900 border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-14">
        <div className="flex items-center gap-6">
          <div className="text-white font-semibold">IVANS Tracker</div>
          <div className="flex gap-1">
            <NavLink to="/tasks" className={linkCls}>Tasks</NavLink>
            <NavLink to="/ingest" className={linkCls}>Ingest</NavLink>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <SyncBadge />
          <span>{user.name}</span>
          <button onClick={logout} className="text-slate-400 hover:text-white">sign out</button>
        </div>
      </div>
    </nav>
  );
}

function Protected({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Nav />
      <main className="flex-1">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/tasks" element={<Protected><Tasks /></Protected>} />
          <Route path="/ingest" element={<Protected><Ingest /></Protected>} />
          <Route path="*" element={<Navigate to="/tasks" replace />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
