import { useMemo, useState } from "react";
import { EmployeeAssignedActivity } from "../../lib/employeeTypes";

export interface JobOption {
  id: string;
  name: string;
}

interface EmployeeJobsFieldProps {
  // Every active Job, or null while loading.
  activeJobs: JobOption[] | null;
  loadError: string | null;
  selectedIds: Set<string>;
  onChange: (next: Set<string>) => void;
  // Inactive Jobs the employee is still assigned to (read-only).
  inactiveAssigned: EmployeeAssignedActivity[];
  error?: string;
}

export function byJobName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

export function jobsSelectedLabel(count: number): string {
  if (count === 0) return "No Jobs selected";
  return `${count} Job${count === 1 ? "" : "s"} selected`;
}

// The Employee form's Jobs section: the employee can use exactly the
// checked Jobs on their phone and in Inputs. Nothing checked means no Jobs —
// never "all Jobs."
export function EmployeeJobsField({ activeJobs, loadError, selectedIds, onChange, inactiveAssigned, error }: EmployeeJobsFieldProps) {
  const [search, setSearch] = useState("");

  const sorted = useMemo(() => (activeJobs ? [...activeJobs].sort(byJobName) : null), [activeJobs]);
  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () => (sorted ? (query ? sorted.filter((j) => j.name.toLowerCase().includes(query)) : sorted) : []),
    [sorted, query]
  );

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  function setVisible(checked: boolean) {
    const next = new Set(selectedIds);
    for (const j of visible) {
      if (checked) next.add(j.id);
      else next.delete(j.id);
    }
    onChange(next);
  }

  const allVisibleChecked = visible.length > 0 && visible.every((j) => selectedIds.has(j.id));
  const noneVisibleChecked = visible.every((j) => !selectedIds.has(j.id));

  return (
    <fieldset className="employee-jobs">
      <legend>Jobs</legend>
      <p className="field-hint">
        The employee can choose only the checked Jobs on their phone, and only these are offered for them in Inputs.
      </p>

      {loadError ? (
        <p className="error-text">{loadError}</p>
      ) : !sorted ? (
        <p>Loading Jobs...</p>
      ) : sorted.length === 0 ? (
        <p className="placeholder-page">No active Jobs exist yet — add them under Basic data → Jobs.</p>
      ) : (
        <>
          <div className="employee-jobs-toolbar">
            <input
              type="search"
              placeholder="Search Jobs"
              aria-label="Search Jobs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button type="button" onClick={() => setVisible(true)} disabled={visible.length === 0 || allVisibleChecked}>
              Select all visible
            </button>
            <button type="button" onClick={() => setVisible(false)} disabled={noneVisibleChecked}>
              Clear all visible
            </button>
          </div>
          <p className="employee-jobs-count" aria-live="polite">
            {jobsSelectedLabel(selectedIds.size)}
            {query ? ` · showing ${visible.length} of ${sorted.length}` : ""}
          </p>
          <div className="employee-jobs-list" role="group" aria-label="Available Jobs">
            {visible.length === 0 ? (
              <p className="employee-jobs-empty">No Jobs match “{search.trim()}”.</p>
            ) : (
              visible.map((j) => (
                <label key={j.id} className="employee-jobs-item">
                  <input type="checkbox" checked={selectedIds.has(j.id)} onChange={() => toggle(j.id)} />
                  {j.name}
                </label>
              ))
            )}
          </div>
        </>
      )}
      {error && <span className="field-error">{error}</span>}

      {inactiveAssigned.length > 0 && (
        <div className="employee-jobs-inactive">
          <p className="employee-jobs-inactive-title">Inactive Jobs still assigned</p>
          <ul>
            {[...inactiveAssigned].sort(byJobName).map((j) => (
              <li key={j.id}>
                {j.name} <span className="status-pill status-inactive">Inactive</span>
              </li>
            ))}
          </ul>
          <p className="field-hint">
            These Jobs are inactive, so they aren't offered anywhere and can't be assigned here. The assignment is kept so
            the employee gets the Job back if it is reactivated; their past time entries are unaffected either way.
          </p>
        </div>
      )}
    </fieldset>
  );
}
