export interface EmployeeDevice {
  id: string;
  name: string | null;
}

export interface EmployeeActivityGroup {
  id: string;
  name: string;
}

export interface EmployeeBreakProfile {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  gender: string | null;
  dateOfBirth: string | null;
  email: string | null;
  phoneNumber: string | null;
  jobGroup: string | null;
  startDate: string;
  isActive: boolean;
  employeeNumber: string | null;
  nationality: "Canadian" | "Mexican" | "Jamaican" | "Guatemalan" | "Filipino" | "Thai";
  preferredLanguage: string | null;
  notes?: string;
  photoUrl: string | null;
  securityRoleId: number;
  securityRole: string;
  teamRoleId: number;
  teamRole: string;
  device: EmployeeDevice | null;
  activityGroups: EmployeeActivityGroup[];
  breakProfileId: string | null;
  breakProfile: EmployeeBreakProfile | null;
  // Never the employee's Employment End Date, and never a reason to
  // auto-deactivate them — purely an optional expiry to track and warn
  // about (see workPermitTypes.ts / the Dashboard's Work Permit Alerts
  // section). Exactly one of the two lead fields is ever non-null when an
  // expiry date is set (see 047_work_permit_tracking.sql).
  workPermitExpiryDate: string | null;
  workPermitNotifyLeadMonths: number | null;
  workPermitNotifyLeadDays: number | null;
  createdAt: string;
  updatedAt: string;
}

export const GENDERS = ["Male", "Female", "Prefer not to say"] as const;
export const LANGUAGES = ["English", "Spanish"] as const;
export const NATIONALITIES = ["Canadian", "Mexican", "Jamaican", "Guatemalan", "Filipino", "Thai"] as const;
