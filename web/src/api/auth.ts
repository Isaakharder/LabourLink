import { apiFetch } from '@/lib/apiClient';

export interface CurrentUser {
  id: number;
  email: string;
  companyId: number;
  employeeId: number | null;
  role: string;
  permissions: string[];
}

export const authApi = {
  me: () => apiFetch<CurrentUser>('/api/auth/me'),

  login: (email: string, password: string) =>
    apiFetch<{ ok: true }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => apiFetch<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
};

export const setupApi = {
  status: () => apiFetch<{ needsSetup: boolean }>('/api/setup/status'),

  bootstrapAdmin: (input: { companyName?: string; email: string; password: string }) =>
    apiFetch<{ ok: true; autoLogin: boolean }>('/api/setup/bootstrap-admin', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
