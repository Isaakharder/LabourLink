export type EmployeeStatus = 'active' | 'inactive' | 'archived';

export type TabId =
  | 'general'
  | 'employment'
  | 'career'
  | 'security'
  | 'devices'
  | 'notes'
  | 'timeline';

export interface CareerRecord {
  id: number;
  site: string | null;
  jobRole: string | null;
  contract: string | null;
  team: string | null;
  supervisor: string | null;
  startedOn: string;
  endedOn: string | null;
}

export interface DeviceRecord {
  id: number;
  name: string;
  identifier: string;
  isShared: boolean;
  assignedSince: string;
  assignedUntil: string | null;
}

export interface TimelineEvent {
  id: number;
  date: string;
  type: 'employment' | 'contract' | 'security' | 'device' | 'archive' | 'note';
  description: string;
  performedBy?: string;
}

export interface EmployeeListItem {
  id: number;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  status: EmployeeStatus;
  contract: string | null;
  jobRole: string | null;
  site: string | null;
}

export interface Employee {
  id: number;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  status: EmployeeStatus;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  site: string | null;
  contract: string | null;
  jobRole: string | null;
  team: string | null;
  supervisor: string | null;
  employmentStartDate: string | null;
  securityRole: string | null;
  hasPin: boolean;
  lastLoginAt: string | null;
  careerHistory: CareerRecord[];
  devices: DeviceRecord[];
  timeline: TimelineEvent[];
}

export interface FormOption {
  id: number;
  name: string;
}

export interface FormOptions {
  sites: FormOption[];
  securityRoles: FormOption[];
  jobRoles: FormOption[];
  contractTemplates: FormOption[];
}

export interface CreateEmployeeInput {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  phone?: string;
  email?: string;
  siteId: number;
  startedOn: string;
  jobRoleId?: number;
  contractTemplateId?: number;
  securityRoleId?: number;
}

export interface ChangeContractInput {
  contractTemplateId: number;
  effectiveDate: string;
  notes?: string;
}

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

export const employeeApi = {
  list: () =>
    apiFetch<EmployeeListItem[]>('/api/employees'),

  detail: (id: number) =>
    apiFetch<Employee>(`/api/employees/${id}`),

  formOptions: () =>
    apiFetch<FormOptions>('/api/employees/form-options'),

  create: (data: CreateEmployeeInput) =>
    apiFetch<{ id: number; employeeNumber: string }>('/api/employees', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (
    id: number,
    data: Partial<Pick<Employee, 'firstName' | 'lastName' | 'dateOfBirth' | 'phone' | 'email' | 'notes'>>,
  ) =>
    apiFetch<{ id: number }>(`/api/employees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  changeContract: (id: number, data: ChangeContractInput) =>
    apiFetch<{ id: number; effectiveDate: string }>(`/api/employees/${id}/change-contract`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
