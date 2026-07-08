const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface ContractListItem {
  id: number;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  profileCount: number;
}

export interface ContractProfile {
  id: number;
  contractTemplateId: number;
  effectiveFrom: string;
  hoursPerWeek: number | null;
  workStartRoundingRule: 'none' | 'round_up' | 'round_down' | 'nearest';
  workStartRoundingMinutes: number;
  allowNightWork: boolean;
  publicHolidayRule: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDetail {
  id: number;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  profiles: ContractProfile[];
}

export interface CreateProfileInput {
  effectiveFrom: string;
  hoursPerWeek?: number | null;
  workStartRoundingRule?: string;
  workStartRoundingMinutes?: number;
  allowNightWork?: boolean;
  publicHolidayRule?: string | null;
}

export const contractApi = {
  list: () =>
    apiFetch<ContractListItem[]>('/api/contracts'),

  detail: (id: number) =>
    apiFetch<ContractDetail>(`/api/contracts/${id}`),

  create: (name: string) =>
    apiFetch<{ id: number; name: string }>('/api/contracts', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  update: (id: number, data: { name?: string; archivedAt?: string | null }) =>
    apiFetch<{ id: number }>(`/api/contracts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  createProfile: (contractId: number, data: CreateProfileInput) =>
    apiFetch<{ id: number }>(`/api/contracts/${contractId}/profiles`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  cloneProfile: (contractId: number, profileId: number, effectiveFrom: string) =>
    apiFetch<{ id: number }>(`/api/contracts/${contractId}/profiles/${profileId}/clone`, {
      method: 'POST',
      body: JSON.stringify({ effectiveFrom }),
    }),

  updateProfile: (
    contractId: number,
    profileId: number,
    data: Partial<CreateProfileInput & { archivedAt: string | null }>,
  ) =>
    apiFetch<{ id: number }>(`/api/contracts/${contractId}/profiles/${profileId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
};
