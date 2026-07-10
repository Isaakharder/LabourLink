import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import { authApi, setupApi, type CurrentUser } from '@/api/auth';
import { setUnauthorizedHandler } from '@/lib/apiClient';

type AuthStatus = 'loading' | 'needs-setup' | 'unauthenticated' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  completeSetup: () => Promise<void>;
  hasPermission: (code: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<CurrentUser | null>(null);

  const bootstrap = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      setStatus('authenticated');
    } catch {
      try {
        const { needsSetup } = await setupApi.status();
        setStatus(needsSetup ? 'needs-setup' : 'unauthenticated');
      } catch {
        setStatus('unauthenticated');
      }
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setStatus('unauthenticated');
    });
    bootstrap();
  }, [bootstrap]);

  const login = useCallback(async (email: string, password: string) => {
    await authApi.login(email, password);
    const me = await authApi.me();
    setUser(me);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  // Called after the first-run setup screen successfully creates the admin
  // (the setup endpoint auto-logs the new admin in via a fresh session).
  const completeSetup = useCallback(async () => {
    const me = await authApi.me();
    setUser(me);
    setStatus('authenticated');
  }, []);

  const hasPermission = useCallback(
    (code: string) => user?.permissions.includes(code) ?? false,
    [user],
  );

  return (
    <AuthContext.Provider value={{ status, user, login, logout, completeSetup, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
