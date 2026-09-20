import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api, ApiError, onSessionExpired } from "../lib/api";

export interface SessionEmployee {
  id: string;
  firstName: string;
  lastName: string;
  securityRole: string;
  teamRole: string;
}

interface AuthContextValue {
  employee: SessionEmployee | null;
  loading: boolean;
  // Set once api()'s onSessionExpired fires (see there for exactly which
  // 401s count) — App.tsx's `!employee` branch already renders LoginPage as
  // soon as employee goes null, so this is purely the explanatory copy:
  // "you were signed in and now aren't" rather than the plain login form a
  // never-authenticated visitor sees. Cleared on the next login attempt.
  sessionExpiredMessage: string | null;
  login: (email: string, pin: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [employee, setEmployee] = useState<SessionEmployee | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  useEffect(() => {
    api<{ employee: SessionEmployee }>("/api/auth/me")
      .then((res) => setEmployee(res.employee))
      .catch(() => setEmployee(null))
      .finally(() => setLoading(false));
  }, []);

  // Global "the session died mid-use" handler — the actual fix for the
  // stale-auth UX: without this, a page whose api() call 401s only updates
  // its own local error/stale state, while this context's `employee` (and
  // therefore the sidebar name, and every other page) stays stuck showing
  // whoever was last signed in.
  useEffect(() => onSessionExpired((message) => {
    setEmployee(null);
    setSessionExpiredMessage(message);
  }), []);

  const login = useCallback(async (email: string, pin: string) => {
    setSessionExpiredMessage(null);
    const res = await api<{ employee: SessionEmployee }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, pin }),
    });
    setEmployee(res.employee);
  }, []);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    setEmployee(null);
    setSessionExpiredMessage(null);
  }, []);

  return (
    <AuthContext.Provider value={{ employee, loading, sessionExpiredMessage, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { ApiError };
