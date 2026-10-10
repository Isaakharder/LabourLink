import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { UNGROUPED_LABEL } from "../../lib/employeeGroupTypes";
import {
  formatDateLong,
  combineDateAndTimeToUtcIso,
  toTimeInputValue,
  todayInAppTimezone,
} from "../../lib/timezone";
import {
  ActivitySelectionFields,
  ActivitySelectionValue,
  buildActivityAnswers,
  EMPTY_ACTIVITY_SELECTION,
  isActivitySelectionComplete,
} from "./ActivitySelectionFields";
import { EmployeeActivityOption, InputsEmployeeOption } from "../../lib/inputsTypes";

export const NO_ELIGIBLE_EMPLOYEES_MESSAGE = "All active employees already have work recorded for this day.";

interface AddEmployeeToDayModalProps {
  date: string;
  onClose: () => void;
  // Who was recorded; duplicate = the server already had this
  // exact submission (a retry after a lost response), nothing new was created.
  onCreated: (employee: { id: string; name: string }, duplicate: boolean) => void;
}

interface EmployeeOptionGroup {
  key: string;
  name: string;
  employees: InputsEmployeeOption[];
}

// Same ordering as the sidebar (EmployeeListPanel's groupEmployees): groups
// alphabetical, Ungrouped last; the server already sorts employees by name.
function groupOptions(employees: InputsEmployeeOption[]): EmployeeOptionGroup[] {
  const byKey = new Map<string, EmployeeOptionGroup>();
  for (const e of employees) {
    const key = e.employeeGroup?.id ?? "";
    const group = byKey.get(key) ?? { key, name: e.employeeGroup?.name ?? UNGROUPED_LABEL, employees: [] };
    group.employees.push(e);
    byKey.set(key, group);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.key === "" || b.key === "") return a.key === "" ? 1 : -1;
    return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  });
}

// "Add employee to this day" (the + beside Review all employees): records
// work for an EXISTING active employee who has no work on the selected date
// yet — they forgot their phone or couldn't start work on it. Never creates
// an employee. Saves through the same POST /api/inputs/activities as Add
// activity (same roles, activity/row/carrier validation, created_by audit
// trail and Manual label) in its addEmployeeToDay mode: no Reason field (the
// server records a standard one), any overlap rejected rather than trimmed,
// and a save-time recheck that the employee still has no work that day. An
// idempotency key per distinct submission makes a retry of the same values
// (e.g. after a timeout whose request actually committed) return the
// already-created entry instead of a duplicate.
export function AddEmployeeToDayModal({ date, onClose, onCreated }: AddEmployeeToDayModalProps) {
  const isPastDate = date < todayInAppTimezone();
  const [employees, setEmployees] = useState<InputsEmployeeOption[] | null>(null);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [selection, setSelection] = useState<ActivitySelectionValue>(EMPTY_ACTIVITY_SELECTION);
  const [activities, setActivities] = useState<EmployeeActivityOption[] | null>(null);
  // Prefilled with "now" only when recording today; a past day has no
  // sensible default.
  const [startTime, setStartTime] = useState(() =>
    date === todayInAppTimezone() ? toTimeInputValue(new Date().toISOString()) : ""
  );
  const [endTime, setEndTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The key is reused only while the request body is unchanged, so a retry
  // of the same submission is recognised but an edited one is a new entry.
  const lastSubmissionRef = useRef<{ body: string; key: string } | null>(null);

  const loadEmployees = useCallback(() => {
    return api<{ employees: InputsEmployeeOption[] }>(`/api/inputs/employee-options?date=${encodeURIComponent(date)}`)
      .then((res) => {
        setEmployees(res.employees);
        setEmployeesError(null);
        return res.employees;
      })
      .catch((err) => {
        setEmployeesError(err instanceof ApiError ? err.message : "Could not load employees");
        return null;
      });
  }, [date]);

  useEffect(() => {
    void loadEmployees();
  }, [loadEmployees]);

  const noneEligible = employees !== null && employees.length === 0;
  const selectedEmployee = employees?.find((e) => e.id === employeeId);
  const selectedActivity = activities?.find((a) => a.id === selection.activityId);
  const endBeforeStart = Boolean(startTime && endTime && endTime <= startTime);
  // An in-progress entry on a day that's already over would stay open until
  // the automatic cutoff closes it — require the end time instead.
  const endTimeRequired = isPastDate;
  const canSubmit =
    Boolean(selectedEmployee) &&
    Boolean(startTime) &&
    (!endTimeRequired || Boolean(endTime)) &&
    !endBeforeStart &&
    isActivitySelectionComplete(selectedActivity, selection) &&
    !submitting;

  function handleEmployeeChange(id: string) {
    setEmployeeId(id);
    // Activities are scoped to the employee's own groups — a previous pick
    // may not exist for the new one.
    setSelection(EMPTY_ACTIVITY_SELECTION);
    setActivities(null);
    setError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !selectedEmployee) return;
    const employeeName = `${selectedEmployee.firstName} ${selectedEmployee.lastName}`;
    setSubmitting(true);
    setError(null);
    const payload = {
      employeeId,
      date,
      activityId: selection.activityId,
      answers: buildActivityAnswers(selectedActivity, selection),
      startTime: combineDateAndTimeToUtcIso(date, startTime),
      endTime: endTime ? combineDateAndTimeToUtcIso(date, endTime) : null,
      addEmployeeToDay: true,
    };
    const body = JSON.stringify(payload);
    const key = lastSubmissionRef.current?.body === body ? lastSubmissionRef.current.key : uuid();
    lastSubmissionRef.current = { body, key };
    try {
      const res = await api<{ ok: true; duplicate?: boolean }>("/api/inputs/activities", {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey: key }),
      });
      onCreated({ id: selectedEmployee.id, name: employeeName }, Boolean(res?.duplicate));
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMPLOYEE_HAS_WORK") {
        // Phone sync or another supervisor added work after this list
        // loaded: nothing was created. Refresh so they drop out of it.
        handleEmployeeChange("");
        await loadEmployees();
        // Set after the reset above, which clears any previous error.
        setError(`${employeeName} now has work recorded for this day, so nothing was added. The employee list has been refreshed.`);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not add the work entry");
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Add employee to this day" onClose={submitting ? () => {} : onClose} wide>
      <form onSubmit={handleSubmit} className="employee-form inputs-add-employee-form" noValidate>
        <p className="inputs-add-employee-date">
          Recording work for <strong>{formatDateLong(date)}</strong>
        </p>
        {noneEligible ? (
          <p className="inputs-add-employee-empty" role="status">
            {NO_ELIGIBLE_EMPLOYEES_MESSAGE}
          </p>
        ) : (
          <div className="employee-form-grid">
            <label>
              Employee *
              <select
                value={employeeId}
                onChange={(e) => handleEmployeeChange(e.target.value)}
                disabled={submitting || !employees}
                required
              >
                <option value="">{employees ? "Select an employee" : "Loading employees…"}</option>
                {employees &&
                  groupOptions(employees).map((g) => (
                    <optgroup key={g.key || "ungrouped"} label={g.name}>
                      {g.employees.map((emp) => (
                        <option key={emp.id} value={emp.id}>
                          {emp.firstName} {emp.lastName}
                        </option>
                      ))}
                    </optgroup>
                  ))}
              </select>
              {employeesError && <span className="field-error">{employeesError}</span>}
            </label>

            {selectedEmployee ? (
              <ActivitySelectionFields
                key={selectedEmployee.id}
                employeeId={selectedEmployee.id}
                value={selection}
                onChange={setSelection}
                disabled={submitting}
                onActivitiesLoaded={setActivities}
              />
            ) : (
              <label>
                Activity *
                <select disabled value="">
                  <option value="">Select an employee first</option>
                </select>
              </label>
            )}

            <label>
              Work start time *
              <input
                type="time"
                step={1}
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={submitting}
                required
              />
            </label>

            <label>
              End time {endTimeRequired ? "*" : "(optional)"}
              <input
                type="time"
                step={1}
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={submitting}
                required={endTimeRequired}
              />
              {endBeforeStart ? (
                <span className="field-error">End time must be after the start time.</span>
              ) : endTimeRequired ? (
                <span className="field-hint">Required for a past day.</span>
              ) : (
                <span className="field-hint">Leave blank if they're still working.</span>
              )}
            </label>
          </div>
        )}

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            {noneEligible ? "Close" : "Cancel"}
          </button>
          {!noneEligible && (
            <button type="submit" className="employee-form-save" disabled={!canSubmit}>
              {submitting ? "Adding…" : "Add to day"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
