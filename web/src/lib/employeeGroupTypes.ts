// DTOs for /api/employee-groups — server/src/routes/employeeGroups.ts.

export interface EmployeeGroupRef {
  id: string;
  name: string;
}

export interface EmployeeGroup extends EmployeeGroupRef {
  employeeCount: number;
  activeEmployeeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeGroupsResponse {
  groups: EmployeeGroup[];
  ungrouped: { employeeCount: number; activeEmployeeCount: number };
}

// Label for employees with no Employee Group (employee_group_id null).
export const UNGROUPED_LABEL = "Ungrouped";
