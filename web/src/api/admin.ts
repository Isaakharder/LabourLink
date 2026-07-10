import { apiFetch } from '@/lib/apiClient';

export interface AdminUser {
  id: number;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  employeeId: number | null;
  employeeName: string | null;
  roleId: number;
  roleName: string;
}

export interface AdminRole {
  id: number;
  name: string;
  description: string | null;
  permissions: string[];
}

export interface AdminSession {
  sid: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
}

export const adminApi = {
  listUsers: () => apiFetch<AdminUser[]>('/api/users'),

  createUser: (input: { email: string; password: string; roleId: number; employeeId?: number | null }) =>
    apiFetch<{ id: number }>('/api/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateUser: (id: number, input: { roleId?: number; isActive?: boolean; employeeId?: number | null }) =>
    apiFetch<{ ok: true }>(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  resetPassword: (id: number, password: string) =>
    apiFetch<{ ok: true }>(`/api/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  listSessions: (id: number) => apiFetch<AdminSession[]>(`/api/users/${id}/sessions`),

  revokeAllSessions: (id: number) =>
    apiFetch<{ ok: true }>(`/api/users/${id}/sessions/revoke-all`, { method: 'POST' }),

  listRoles: () => apiFetch<AdminRole[]>('/api/users/roles'),
};
