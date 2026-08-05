import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { DateNav } from "../../components/inputs/DateNav";
import { EmployeeListPanel } from "../../components/inputs/EmployeeListPanel";
import { ActivityLogsCard } from "../../components/inputs/ActivityLogsCard";
import { WorkdayDetailsCard, EditingBreakField } from "../../components/inputs/WorkdayDetailsCard";
import { TimeCorrectionModal } from "../../components/inputs/TimeCorrectionModal";
import { DeleteTimeEntryModal } from "../../components/inputs/DeleteTimeEntryModal";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { ActivityRunDto, BreakDto, DailyInputsResponse, InputsEmployee } from "../../lib/inputsTypes";
import {
  combineDateAndTimeToUtcIso,
  formatTimeInAppTimezone,
  todayInAppTimezone,
  toTimeInputValue,
} from "../../lib/timezone";

// Covers all three correctable timestamps this page supports — an activity
// run's end time, and a break's start or end time — through the one
// TimeCorrectionModal, rather than a separate pending-state shape (and
// separate modal) per field.
interface PendingCorrection {
  kind: "run-end" | "break-start" | "break-end";
  id: string;
  subjectLabel: string;
  fieldLabel: string;
  oldDisplay: string;
  newDisplay: string;
  payload: { startTime?: string; endTime?: string };
}

interface PendingDeletion {
  kind: "activity-run" | "break";
  id: string;
  title: string;
  message: string;
  confirmLabel: string;
}

export function InputsPage() {
  const { employee: currentEmployee } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const date = searchParams.get("date") ?? todayInAppTimezone();
  const selectedEmployeeId = searchParams.get("employee");

  const [employees, setEmployees] = useState<InputsEmployee[] | null>(null);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [daily, setDaily] = useState<DailyInputsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [editTimeValue, setEditTimeValue] = useState("");

  const [selectedBreakId, setSelectedBreakId] = useState<string | null>(null);
  const [editingBreak, setEditingBreak] = useState<EditingBreakField | null>(null);
  const [editBreakTimeValue, setEditBreakTimeValue] = useState("");

  const [pendingCorrection, setPendingCorrection] = useState<PendingCorrection | null>(null);
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null);
  const [deletionSubmitting, setDeletionSubmitting] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);

  function updateParams(next: { date?: string; employee?: string }) {
    const params = new URLSearchParams(searchParams);
    if (next.date !== undefined) params.set("date", next.date);
    if (next.employee !== undefined) params.set("employee", next.employee);
    setSearchParams(params, { replace: true });
  }

  const loadEmployees = useCallback(() => {
    const params = new URLSearchParams();
    if (employeeSearch.trim()) params.set("search", employeeSearch.trim());
    api<{ employees: InputsEmployee[] }>(`/api/inputs/employees?${params.toString()}`)
      .then((res) => {
        setEmployees(res.employees);
        setEmployeesError(null);
      })
      .catch((err) => {
        setEmployeesError(err instanceof ApiError ? err.message : "Could not load employees");
      });
  }, [employeeSearch]);

  useEffect(() => {
    const t = window.setTimeout(loadEmployees, employeeSearch ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [loadEmployees, employeeSearch]);

  // Auto-select once an employee list is available and nothing is selected
  // yet (a fresh /inputs visit with no ?employee= param): prefer the
  // signed-in employee if they're in the active list, else the first
  // employee alphabetically. Guarded on selectedEmployeeId so this never
  // fires again — and never overrides an explicit pick — once ?employee= is
  // set, including by this same effect.
  useEffect(() => {
    if (selectedEmployeeId || !employees || employees.length === 0) return;
    const signedIn = currentEmployee ? employees.find((e) => e.id === currentEmployee.id) : undefined;
    updateParams({ employee: (signedIn ?? employees[0]).id, date });
  }, [employees, selectedEmployeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDaily = useCallback(() => {
    if (!selectedEmployeeId) return Promise.resolve();
    return api<DailyInputsResponse>(
      `/api/inputs/daily?employeeId=${encodeURIComponent(selectedEmployeeId)}&date=${encodeURIComponent(date)}`
    )
      .then((res) => {
        setDaily(res);
        setError(null);
        // Server truth just replaced everything derived — never keep a
        // selection or in-flight edit pointed at a row that may have moved,
        // merged, or disappeared as a result of the change that triggered
        // this reload.
        setSelectedRunId(null);
        setEditingRunId(null);
        setSelectedBreakId(null);
        setEditingBreak(null);
      })
      .catch((err) => {
        setDaily(null);
        setError(err instanceof ApiError ? err.message : "Could not load activity logs");
      });
  }, [selectedEmployeeId, date]);

  useEffect(() => {
    // A fresh load triggered by an employee/date navigation change (this
    // effect's only trigger, since loadDaily's identity only changes with
    // those two deps) — any success banner left over from a previous
    // action no longer applies to what's about to be shown.
    setSuccessMessage(null);
    loadDaily();
  }, [loadDaily]);

  function handleSelectRun(id: string) {
    setSelectedRunId(id);
    if (editingRunId && editingRunId !== id) setEditingRunId(null);
  }

  function handleStartEdit(run: ActivityRunDto) {
    if (!run.canEdit || !run.endedAt) return;
    setEditingRunId(run.id);
    setEditTimeValue(toTimeInputValue(run.endedAt));
  }

  function handleCancelEdit() {
    setEditingRunId(null);
  }

  function handleSaveEdit() {
    if (!editingRunId || !daily || !editTimeValue) return;
    const run = daily.runs.find((r) => r.id === editingRunId);
    if (!run) return;
    const newEndTimeIso = combineDateAndTimeToUtcIso(date, editTimeValue);
    setEditingRunId(null);
    setCorrectionError(null);
    setPendingCorrection({
      kind: "run-end",
      id: run.id,
      subjectLabel: run.activityName,
      fieldLabel: "End Time",
      oldDisplay: run.endedAt ? formatTimeInAppTimezone(run.endedAt) : "—",
      newDisplay: formatTimeInAppTimezone(newEndTimeIso),
      payload: { endTime: newEndTimeIso },
    });
  }

  function handleSelectBreak(id: string) {
    setSelectedBreakId(id);
    if (editingBreak && editingBreak.id !== id) setEditingBreak(null);
  }

  function handleStartEditBreak(brk: BreakDto, field: "start" | "end") {
    if (!brk.canEdit) return;
    if (field === "end" && !brk.endedAt) return;
    setEditingBreak({ id: brk.id, field });
    setEditBreakTimeValue(toTimeInputValue(field === "start" ? brk.startedAt : brk.endedAt!));
  }

  function handleCancelEditBreak() {
    setEditingBreak(null);
  }

  function handleSaveEditBreak() {
    if (!editingBreak || !daily || !editBreakTimeValue) return;
    const brk = daily.breaks.find((b) => b.id === editingBreak.id);
    if (!brk) return;
    const { field } = editingBreak;
    const newTimeIso = combineDateAndTimeToUtcIso(date, editBreakTimeValue);
    setEditingBreak(null);
    setCorrectionError(null);
    setPendingCorrection({
      kind: field === "start" ? "break-start" : "break-end",
      id: brk.id,
      subjectLabel: brk.name ?? "Break",
      fieldLabel: field === "start" ? "Start Time" : "End Time",
      oldDisplay:
        field === "start"
          ? formatTimeInAppTimezone(brk.startedAt)
          : brk.endedAt
          ? formatTimeInAppTimezone(brk.endedAt)
          : "—",
      newDisplay: formatTimeInAppTimezone(newTimeIso),
      payload: field === "start" ? { startTime: newTimeIso } : { endTime: newTimeIso },
    });
  }

  async function handleConfirmCorrection(reason: string) {
    if (!pendingCorrection) return;
    setCorrectionSubmitting(true);
    setCorrectionError(null);
    try {
      const path =
        pendingCorrection.kind === "run-end"
          ? `/api/inputs/activity-runs/${pendingCorrection.id}/end-time`
          : `/api/inputs/breaks/${pendingCorrection.id}`;
      await api(path, {
        method: "PATCH",
        body: JSON.stringify({ ...pendingCorrection.payload, reason }),
      });
      setPendingCorrection(null);
      await loadDaily();
      setSuccessMessage("Correction saved.");
    } catch (err) {
      setCorrectionError(err instanceof ApiError ? err.message : "Could not save correction");
    } finally {
      setCorrectionSubmitting(false);
    }
  }

  function handleCancelCorrection() {
    if (correctionSubmitting) return;
    setPendingCorrection(null);
    setCorrectionError(null);
  }

  function handleDeleteRun(run: ActivityRunDto) {
    setDeletionError(null);
    setPendingDeletion({
      kind: "activity-run",
      id: run.id,
      title: "Delete activity log?",
      message:
        "This will remove this recorded activity from the employee's day. The deletion will remain in the audit history.",
      confirmLabel: "Delete Log",
    });
  }

  function handleDeleteBreak(brk: BreakDto) {
    setDeletionError(null);
    setPendingDeletion({
      kind: "break",
      id: brk.id,
      title: "Delete break?",
      message:
        "This will remove this break from the employee's day and reconnect the surrounding work time. The deletion will remain in the audit history.",
      confirmLabel: "Delete Break",
    });
  }

  async function handleConfirmDeletion(reason: string) {
    // Belt-and-suspenders against a double-fire (e.g. a fast repeat Enter):
    // the modal's own submit guard already disables the button while
    // submitting, this just makes the same guarantee at the handler level.
    if (!pendingDeletion || deletionSubmitting) return;
    setDeletionSubmitting(true);
    setDeletionError(null);
    try {
      const path =
        pendingDeletion.kind === "activity-run"
          ? `/api/inputs/activity-runs/${pendingDeletion.id}/delete`
          : `/api/inputs/breaks/${pendingDeletion.id}/delete`;
      await api(path, { method: "POST", body: JSON.stringify({ reason }) });
      const deletedKind = pendingDeletion.kind;
      setPendingDeletion(null);
      await loadDaily();
      setSuccessMessage(deletedKind === "activity-run" ? "Activity log deleted." : "Break deleted.");
    } catch (err) {
      setDeletionError(err instanceof ApiError ? err.message : "Could not delete");
    } finally {
      setDeletionSubmitting(false);
    }
  }

  function handleCancelDeletion() {
    if (deletionSubmitting) return;
    setPendingDeletion(null);
    setDeletionError(null);
  }

  return (
    <div className="inputs-page">
      <PageHeader title="Inputs" description="Review and correct daily employee activity logs." />

      <div className="inputs-workspace">
        <EmployeeListPanel
          employees={employees}
          error={employeesError}
          selectedId={selectedEmployeeId}
          onSelect={(id) => updateParams({ employee: id })}
          search={employeeSearch}
          onSearchChange={setEmployeeSearch}
        />

        <div className="inputs-workspace-main">
          <div className="inputs-workspace-datenav">
            <DateNav date={date} onChange={(d) => updateParams({ date: d })} />
          </div>

          {error && <p className="error-text inputs-workspace-placeholder">{error}</p>}
          {successMessage && <p className="success-text inputs-workspace-placeholder">{successMessage}</p>}

          {!selectedEmployeeId ? (
            employeesError ? null : (
              <p className="placeholder-page inputs-workspace-placeholder">
                Select an employee to view their activity logs.
              </p>
            )
          ) : !daily ? (
            <p className="inputs-workspace-placeholder">Loading...</p>
          ) : (
            <>
              <ActivityLogsCard
                employee={daily.employee}
                date={daily.date}
                runs={daily.runs}
                totals={daily.totals}
                selectedRunId={selectedRunId}
                onSelectRun={handleSelectRun}
                editingRunId={editingRunId}
                editTimeValue={editTimeValue}
                onStartEdit={handleStartEdit}
                onEditTimeChange={setEditTimeValue}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={handleCancelEdit}
                onDeleteRun={handleDeleteRun}
              />
              <WorkdayDetailsCard
                workStartTime={daily.workStartTime}
                breaks={daily.breaks}
                paidBreakSeconds={daily.totals.paidBreakSeconds}
                unpaidBreakSeconds={daily.totals.unpaidBreakSeconds}
                selectedBreakId={selectedBreakId}
                onSelectBreak={handleSelectBreak}
                editingBreak={editingBreak}
                editBreakTimeValue={editBreakTimeValue}
                onStartEditBreak={handleStartEditBreak}
                onEditBreakTimeChange={setEditBreakTimeValue}
                onSaveEditBreak={handleSaveEditBreak}
                onCancelEditBreak={handleCancelEditBreak}
                onDeleteBreak={handleDeleteBreak}
              />
            </>
          )}
        </div>
      </div>

      {pendingCorrection && (
        <TimeCorrectionModal
          subjectLabel={pendingCorrection.subjectLabel}
          fieldLabel={pendingCorrection.fieldLabel}
          oldDisplay={pendingCorrection.oldDisplay}
          newDisplay={pendingCorrection.newDisplay}
          submitting={correctionSubmitting}
          error={correctionError}
          onConfirm={handleConfirmCorrection}
          onCancel={handleCancelCorrection}
        />
      )}

      {pendingDeletion && (
        <DeleteTimeEntryModal
          title={pendingDeletion.title}
          message={pendingDeletion.message}
          confirmLabel={pendingDeletion.confirmLabel}
          submitting={deletionSubmitting}
          error={deletionError}
          onConfirm={handleConfirmDeletion}
          onCancel={handleCancelDeletion}
        />
      )}
    </div>
  );
}
