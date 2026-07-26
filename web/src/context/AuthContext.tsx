import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api, ApiError } from "../lib/api";

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
  login: (email: string, pin: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [employee, setEmployee] = useState<SessionEmployee | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ employee: SessionEmployee }>("/api/auth/me")
      .then((res) => setEmployee(res.employee))
      .catch(() => setEmployee(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, pin: string) => {
    const res = await api<{ employee: SessionEmployee }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, pin }),
    });
    setEmployee(res.employee);
  }, []);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    setEmployee(null);
  }, []);

  return (
    <AuthContext.Provider value={{ employee, loading, login, logout }}>
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
