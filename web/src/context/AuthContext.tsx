import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
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
  // True until the first session check has an answer — signed in, or
  // definitely signed out. Never ends on a network failure: see reconnecting.
  loading: boolean;
  // The startup session check couldn't reach the server (offline, timeout,
  // 5xx) and is retrying. The sign-in itself lives in httpOnly cookies the
  // server renews (server/src/lib/webSessions.ts), so not reaching the server
  // says nothing about whether it is still valid — App.tsx shows a
  // "reconnecting" screen, never the login form, until the server answers.
  reconnecting: boolean;
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

// Survives reloads: a sign-out whose server call hasn't succeeded yet (e.g.
// signed out while offline). Until it does, startup never restores the
// session — it finishes the sign-out instead.
export const SIGN_OUT_PENDING_KEY = "labourlink.auth.signOutPending";
// Written on sign-in/sign-out so every other open tab follows along (the
// `storage` event only fires in the other tabs). Holds no identity or token.
export const AUTH_EVENT_KEY = "labourlink.auth.event";

// Startup retry delays while the server can't be reached; the last one
// repeats. Coming back online or to the tab retries immediately.
export const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 30000];

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable (private mode quota etc.) — the in-memory sign-out
    // below still happens; only the reload-proof retry is lost.
  }
}

function broadcastAuthEvent(type: "signed-in" | "signed-out") {
  try {
    localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ type, at: Date.now() }));
  } catch {
    // Other tabs still find out on their next request (401 / no cookie).
  }
}

// "The server answered and said no" (signed out) vs anything that only
// means "didn't get an answer" — offline, timeout, or a 5xx such as the
// server's 503 when it can't reach its database to renew the session.
function isDefinitiveAuthFailure(err: unknown): boolean {
  return err instanceof ApiError && err.status < 500;
}

async function sendSignOut(): Promise<boolean> {
  try {
    await api("/api/auth/logout", { method: "POST" });
    writeFlag(SIGN_OUT_PENDING_KEY, false);
    return true;
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [employee, setEmployee] = useState<SessionEmployee | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  const attemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const restoringRef = useRef(false);
  const unmountedRef = useRef(false);

  const restore = useCallback(async () => {
    if (restoringRef.current || unmountedRef.current) return;
    restoringRef.current = true;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    try {
      if (readFlag(SIGN_OUT_PENDING_KEY)) {
        // Signed out on purpose: stay signed out whether or not the server
        // call gets through this time (it's retried on reconnect).
        await sendSignOut();
        if (unmountedRef.current) return;
        setEmployee(null);
        setReconnecting(false);
        setLoading(false);
        return;
      }
      const res = await api<{ employee: SessionEmployee }>("/api/auth/me");
      if (unmountedRef.current) return;
      attemptRef.current = 0;
      setEmployee(res.employee);
      setReconnecting(false);
      setLoading(false);
    } catch (err) {
      if (unmountedRef.current) return;
      if (isDefinitiveAuthFailure(err)) {
        attemptRef.current = 0;
        setEmployee(null);
        setReconnecting(false);
        setLoading(false);
        return;
      }
      setReconnecting(true);
      const delay = RECONNECT_DELAYS_MS[Math.min(attemptRef.current, RECONNECT_DELAYS_MS.length - 1)];
      attemptRef.current += 1;
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        void restore();
      }, delay);
    } finally {
      restoringRef.current = false;
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    void restore();
    return () => {
      unmountedRef.current = true;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    };
  }, [restore]);

  // While reconnecting, don't wait out the backoff once the network or the
  // tab comes back. A pending sign-out is also finished as soon as possible.
  useEffect(() => {
    function onBack() {
      if (document.visibilityState === "hidden") return;
      if (readFlag(SIGN_OUT_PENDING_KEY)) void sendSignOut();
      if (retryTimerRef.current !== null) void restore();
    }
    window.addEventListener("online", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      window.removeEventListener("online", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [restore]);

  // Other tabs: a sign-out there signs this tab out at once; a sign-in there
  // is picked up here (the cookies are shared) without asking for the PIN.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== AUTH_EVENT_KEY || !e.newValue) return;
      let type: unknown;
      try {
        type = (JSON.parse(e.newValue) as { type?: unknown }).type;
      } catch {
        return;
      }
      if (type === "signed-out") {
        setEmployee(null);
        setSessionExpiredMessage(null);
        setLoading(false);
      } else if (type === "signed-in") {
        setSessionExpiredMessage(null);
        void restore();
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [restore]);

  // Global "the session died mid-use" handler — the actual fix for the
  // stale-auth UX: without this, a page whose api() call 401s only updates
  // its own local error/stale state, while this context's `employee` (and
  // therefore the sidebar name, and every other page) stays stuck showing
  // whoever was last signed in. With server-side renewal, such a 401 now
  // only happens once the sign-in itself is gone (signed out elsewhere,
  // revoked, or past its lifetime) — never just because a day has passed.
  useEffect(() => onSessionExpired((message) => {
    setEmployee(null);
    setSessionExpiredMessage(message);
  }), []);

  const login = useCallback(async (email: string, pin: string) => {
    setSessionExpiredMessage(null);
    // Best effort: revoke an earlier sign-out's session first if that never
    // reached the server. The new sign-in replaces its cookies either way.
    if (readFlag(SIGN_OUT_PENDING_KEY)) await sendSignOut();
    const res = await api<{ employee: SessionEmployee }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, pin }),
    });
    writeFlag(SIGN_OUT_PENDING_KEY, false);
    setEmployee(res.employee);
    broadcastAuthEvent("signed-in");
  }, []);

  // Signs out locally first and unconditionally, so it takes effect at once
  // even offline; the server call that revokes the session is then retried
  // until it succeeds (SIGN_OUT_PENDING_KEY).
  const logout = useCallback(async () => {
    writeFlag(SIGN_OUT_PENDING_KEY, true);
    setEmployee(null);
    setSessionExpiredMessage(null);
    broadcastAuthEvent("signed-out");
    await sendSignOut();
  }, []);

  return (
    <AuthContext.Provider value={{ employee, loading, reconnecting, sessionExpiredMessage, login, logout }}>
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
