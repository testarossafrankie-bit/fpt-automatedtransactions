// Plaintext local auth — matches portal pattern (vite_auth_plaintext_deferred).
// Just a name + simple hardcoded owner check for now. Swap to real list once
// KV + user table land.
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'ivansTrackerUser';

const USERS = [
  { name: 'Frank Terragrossa', role: 'owner', password: '' },
];

export function useAuth() {
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    else localStorage.removeItem(STORAGE_KEY);
  }, [user]);

  const login = (name, password) => {
    const match = USERS.find(u =>
      u.name.toLowerCase() === String(name || '').trim().toLowerCase()
    );
    if (!match) return { ok: false, error: 'Name not recognized' };
    if (match.password && match.password !== password) return { ok: false, error: 'Wrong password' };
    setUser({ name: match.name, role: match.role });
    return { ok: true };
  };

  const logout = () => setUser(null);

  return { user, login, logout };
}
