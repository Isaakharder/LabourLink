import { apiFetch } from '@/lib/apiClient';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmployeeStatus = 'working' | 'on_break' | 'on_lunch' | 'idle' | 'clocked_out';

export interface DashboardEmployee {
  sessionId: number;
  employeeId: number;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  clockedInAt: string;
  clockedOutAt: string | null;
  status: EmployeeStatus;
  currentActivity: { id: number; code: string; name: string; color: string | null } | null;
  currentLocation: { id: number; code: string; name: string } | null;
  currentRegStartedAt: string | null;
  totalRegSeconds: number;
  totalBreakSeconds: number;
}

export interface DashboardResponse {
  date: string;
  employees: DashboardEmployee[];
}

export interface Registration {
  id: number;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  activityId: number;
  activityCode: string;
  activityName: string;
  activityColor: string | null;
  locationId: number | null;
  locationCode: string | null;
  locationName: string | null;
  carrierId: number | null;
  isBreak: boolean;
  isVoided: boolean;
}

export interface DaySummary {
  clockedInAt: string;
  clockedOutAt: string | null;
  breaks: { startedAt: string; endedAt: string | null; durationSeconds: number | null }[];
  lunches: { startedAt: string; endedAt: string | null; durationSeconds: number | null }[];
  totalRegSeconds: number;
  totalBreakSeconds: number;
  totalPaidSeconds: number | null;
}

export interface EmployeeDayResponse {
  session: {
    id: number;
    employeeId: number;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    workDate: string;
    clockedInAt: string;
    clockedOutAt: string | null;
  };
  registrations: Registration[];
  summary: DaySummary;
}

// ── API ───────────────────────────────────────────────────────────────────────

export const workApi = {
  inputDashboard: (date: string, siteId?: number) => {
    const params = new URLSearchParams({ date });
    if (siteId) params.set('siteId', String(siteId));
    return apiFetch<DashboardResponse>(`/api/work/input-dashboard?${params}`);
  },

  employeeDay: (employeeId: number, date: string) =>
    apiFetch<EmployeeDayResponse>(`/api/work/employees/${employeeId}/day?date=${date}`),
};
