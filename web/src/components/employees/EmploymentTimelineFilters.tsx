import { MultiSelectFilterDropdown } from "./MultiSelectFilterDropdown";
import { EMPLOYMENT_TYPES, EmploymentPeriodStatus, EmploymentTimelineFilterState, STATUS_LABELS, WORK_GROUPS } from "../../lib/employmentPeriodTypes";
import { NATIONALITIES } from "../../lib/employeeTypes";
import { UNGROUPED_LABEL } from "../../lib/employeeGroupTypes";

interface EmployeeOption {
  id: string;
  firstName: string;
  lastName: string;
}

interface EmploymentTimelineFiltersProps {
  filters: EmploymentTimelineFilterState;
  onChange: (next: EmploymentTimelineFilterState) => void;
  employees: EmployeeOption[];
  // Employee Groups present among the timeline's employees, by name.
  employeeGroups: { id: string; name: string }[];
}

const STATUS_OPTIONS: { value: EmploymentPeriodStatus; label: string }[] = (
  ["current", "startingSoon", "finishingSoon", "future", "permitExpired", "completed"] as EmploymentPeriodStatus[]
).map((s) => ({ value: s, label: STATUS_LABELS[s] }));

export function EmploymentTimelineFilters({ filters, onChange, employees, employeeGroups }: EmploymentTimelineFiltersProps) {
  return (
    <div className="employment-timeline-filters">
      <MultiSelectFilterDropdown
        label="Employee"
        searchable
        options={employees.map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }))}
        selected={filters.employeeIds}
        onChange={(employeeIds) => onChange({ ...filters, employeeIds })}
      />
      <MultiSelectFilterDropdown
        label="Nationality"
        options={NATIONALITIES.map((n) => ({ value: n, label: n }))}
        selected={filters.nationalities}
        onChange={(nationalities) => onChange({ ...filters, nationalities })}
      />
      <MultiSelectFilterDropdown
        label="Employee Group"
        options={[...employeeGroups.map((g) => ({ value: g.id, label: g.name })), { value: "Ungrouped", label: UNGROUPED_LABEL }]}
        selected={filters.employeeGroupIds}
        onChange={(employeeGroupIds) => onChange({ ...filters, employeeGroupIds })}
      />
      <MultiSelectFilterDropdown
        label="Work Group"
        options={[...WORK_GROUPS.map((g) => ({ value: g, label: g })), { value: "Unspecified", label: "Unspecified" }]}
        selected={filters.workGroups}
        onChange={(workGroups) => onChange({ ...filters, workGroups })}
      />
      <MultiSelectFilterDropdown
        label="Employment Type"
        options={[...EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t })), { value: "Unspecified", label: "Unspecified" }]}
        selected={filters.employmentTypes}
        onChange={(employmentTypes) => onChange({ ...filters, employmentTypes })}
      />
      <MultiSelectFilterDropdown
        label="Status"
        options={STATUS_OPTIONS}
        selected={filters.statuses}
        onChange={(statuses) => onChange({ ...filters, statuses: statuses as EmploymentPeriodStatus[] })}
      />
    </div>
  );
}
