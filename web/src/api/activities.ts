export type ActivityTabId = 'general' | 'rules' | 'mobile' | 'history';

export interface ActivityListItem {
  id: number;
  code: string;
  name: string;
  displayName: string | null;
  groupId: number;
  groupName: string;
  groupSortOrder: number;
  defaultUnitId: number | null;
  defaultUnit: string | null;
  icon: string | null;
  color: string | null;
  visibleOnMobile: boolean;
  sortOrder: number;
  archivedAt: string | null;
}

export interface Activity {
  id: number;
  code: string;
  name: string;
  displayName: string | null;
  groupId: number;
  groupName: string;
  defaultUnitId: number | null;
  defaultUnitCode: string | null;
  defaultUnit: string | null;
  icon: string | null;
  color: string | null;
  requiresLocation: boolean;
  requiresCarrier: boolean;
  requiresYield: boolean;
  requiresCrop: boolean;
  requiresNote: boolean;
  requiresPhoto: boolean;
  requiresQuestion: boolean;
  visibleOnMobile: boolean;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityFormOption {
  id: number;
  name: string;
}

export interface UnitOption {
  id: number;
  code: string;
  name: string;
}

export interface ActivityFormOptions {
  groups: ActivityFormOption[];
  units: UnitOption[];
}

export interface CreateActivityInput {
  name: string;
  displayName?: string;
  groupId: number;
  defaultUnitId?: number;
  icon?: string;
  color?: string;
  requiresLocation?: boolean;
  requiresCarrier?: boolean;
  requiresYield?: boolean;
  requiresCrop?: boolean;
  visibleOnMobile?: boolean;
  sortOrder?: number;
}

export type UpdateActivityInput = Partial<{
  name: string;
  displayName: string | null;
  groupId: number;
  defaultUnitId: number | null;
  icon: string | null;
  color: string | null;
  requiresLocation: boolean;
  requiresCarrier: boolean;
  requiresYield: boolean;
  requiresCrop: boolean;
  requiresNote: boolean;
  requiresPhoto: boolean;
  requiresQuestion: boolean;
  visibleOnMobile: boolean;
  sortOrder: number;
  archivedAt: string | null;
}>;

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

export const activityApi = {
  list: () =>
    apiFetch<ActivityListItem[]>('/api/activities'),

  detail: (id: number) =>
    apiFetch<Activity>(`/api/activities/${id}`),

  formOptions: () =>
    apiFetch<ActivityFormOptions>('/api/activities/form-options'),

  create: (data: CreateActivityInput) =>
    apiFetch<{ id: number; code: string }>('/api/activities', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: number, data: UpdateActivityInput) =>
    apiFetch<{ id: number }>(`/api/activities/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
};
