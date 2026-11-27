import { useCallback, useEffect, useState } from 'react';
import { AdminWorkspace } from './components/AdminWorkspace.tsx';
import { AuthPortal } from './components/AuthPortal.tsx';
import { SupervisorWorkspace } from './components/SupervisorWorkspace.tsx';
import { apiFetch, setAuthToken } from './lib/api.ts';
import type { AuthUser } from './types.ts';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [idleLockedMsg, setIdleLockedMsg] = useState<string | null>(null);

  const handleAuthenticated = useCallback((authUser: AuthUser, token: string) => {
    setAuthToken(token);
    setUser(authUser);
    setIdleLockedMsg(null);
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore if session already expired
    }
    setAuthToken(null);
    setUser(null);
  }, []);

  // Periodic server session check for FR-AUT-07 idle lock
  useEffect(() => {
    if (!user) return;
    const id = setInterval(async () => {
      try {
        await apiFetch('/api/auth/me');
      } catch {
        setAuthToken(null);
        setUser(null);
        setIdleLockedMsg('Sesi Anda dikunci otomatis karena tidak ada aktivitas (FR-AUT-07). Silakan masuk kembali.');
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [user]);

  if (!user) {
    return (
      <>
        {idleLockedMsg && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 text-center text-xs font-medium text-amber-900">
            {idleLockedMsg}
          </div>
        )}
        <AuthPortal onAuthenticated={handleAuthenticated} />
      </>
    );
  }

  if (user.role === 'admin') {
    return (
      <AdminWorkspace
        user={user}
        onLogout={handleLogout}
        onUserUpdated={(updated) => setUser(updated)}
      />
    );
  }

  return (
    <SupervisorWorkspace
      user={user}
      onLogout={handleLogout}
      onUserUpdated={(updated) => setUser(updated)}
    />
  );
}
