export interface EmployeeDevice {
  id: string;
  name: string | null;
}

export interface EmployeeActivityGroup {
  id: string;
  name: string;
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
  nationality: "Canadian" | "Mexican";
  preferredLanguage: string | null;
  notes?: string;
  photoUrl: string | null;
  securityRoleId: number;
  securityRole: string;
  teamRoleId: number;
  teamRole: string;
  device: EmployeeDevice | null;
  activityGroup: EmployeeActivityGroup | null;
  createdAt: string;
  updatedAt: string;
}

export const GENDERS = ["Male", "Female", "Prefer not to say"] as const;
export const LANGUAGES = ["English", "Spanish"] as const;
export const NATIONALITIES = ["Canadian", "Mexican"] as const;
