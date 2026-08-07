import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { DateNav } from "../../components/inputs/DateNav";
import { EmployeeListPanel } from "../../components/inputs/EmployeeListPanel";
import { ActivityLogsCard } from "../../components/inputs/ActivityLogsCard";
import { WorkdayDetailsCard, EditingBreakField } from "../../components/inputs/WorkdayDetailsCard";
import { DeleteTimeEntryModal } from "../../components/inputs/DeleteTimeEntryModal";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { ActivityRunDto, BreakDto, DailyInputsResponse, InputsEmployee } from "../../lib/inputsTypes";
import {
  APP_TIMEZONE,
  combineDateAndTimeToUtcIso,
  todayInAppTimezone,
  toTimeInputValue,
} from "../../lib/timezone";

// Background refresh cadence for the selected employee/day while the page
// is open — reconciles with server truth without a manual reload. Kept in
// sync with GreenhouseDisplayPage's POLL_INTERVAL_MS for the same cadence
// convention elsewhere in the app; the two aren't shared because they poll
// unrelated endpoints for unrelated reasons.
const POLL_INTERVAL_MS = 10000;

// "12:56 PM" — a client-clock event (when this browser last successfully
// fetched), not a server timestamp, so it's formatted directly rather than
// through formatTimeInAppTimezone (which converts a server ISO instant).
function formatClockTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
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
  // Separate from `error` above on purpose: `error` is only ever touched by
  // loadDaily (foreground load failure / background success clearing a
  // prior one). A save's own failure used to reuse `error` too, but the
  // "resume polling immediately" effect fires a background refresh the
  // moment the save's actionInFlight flag clears — success or failure —
  // and that refresh's own success handler unconditionally clears `error`,
  // wiping the just-set message within a few hundred ms, far too fast to
  // read. actionError is never touched by loadDaily in any path, so a
  // background refresh landing right after a failed save can no longer
  // race it away.
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [editTimeValue, setEditTimeValue] = useState("");

  const [selectedBreakId, setSelectedBreakId] = useState<string | null>(null);
  const [editingBreak, setEditingBreak] = useState<EditingBreakField | null>(null);
  const [editBreakTimeValue, setEditBreakTimeValue] = useState("");

  const [editingWorkStart, setEditingWorkStart] = useState(false);
  const [editWorkStartTimeValue, setEditWorkStartTimeValue] = useState("");

  // Corrections (end time, break start/end, work start) now save directly
  // on Save/Enter — no reason prompt, no confirmation modal (see the
  // removed TimeCorrectionModal). This just covers the brief window a
  // direct save's own request is in flight, for the pause-gate effect
  // below; per-field errors surface through the page's existing `error`
  // banner rather than a modal-local one.
  const [actionInFlight, setActionInFlight] = useState(false);

  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null);
  const [deletionSubmitting, setDeletionSubmitting] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);

  // Background live-refresh state — distinct from `error`/`daily` above,
  // which are only ever touched by a foreground (initial/employee/date)
  // load so a failed background poll can never blank an already-loaded
  // page or show the big error banner (see loadDaily's `background` branch).
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  // Read by the interval/visibility/focus/online handlers below, of "is the
  // employee mid-edit or mid-submit right now" — a ref rather than a
  // dependency those effects re-subscribe on, so the 10s interval timer
  // itself doesn't reset every keystroke while still always seeing the
  // current value at the moment it fires. Synced, and used to trigger an
  // immediate resume-refresh on the falling edge, in the effect just below
  // loadDaily's own declaration (it needs to call loadDaily on that edge).
  const pausedRef = useRef(false);

  // Race protection (requirement 8): every loadDaily call aborts whatever
  // it superseded and stamps a new sequence number; a response only gets
  // applied if it's still the most recent request in flight when it
  // resolves. Covers fast employee/date switches and overlapping triggers
  // (poll tick + focus + correction success, etc.) landing out of order.
  const requestSeqRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    // Reset (not just initialize via useRef's default) on every effect run,
    // not only the cleanup below — React.StrictMode's dev-only double-invoke
    // simulates an unmount+remount on first mount, running this cleanup once
    // before the "real" mount. Without re-arming it here, isMountedRef would
    // latch permanently false after that simulated cycle and every future
    // loadDaily response would be silently discarded as "unmounted" even
    // though the component is genuinely still on screen.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

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

  // `background: true` marks a poll/visibility/focus/online-triggered
  // refresh — every other caller (initial/employee/date load, and the
  // post-correction/post-deletion reloads) is a real navigation/mutation
  // and keeps the original "reset every selection, show the big error
  // banner on failure" behavior. A background refresh instead: never shows
  // the error banner or blanks `daily` on failure (just flags `stale`), and
  // only clears a selected (not actively-edited — see pausedRef, which
  // already keeps a background call from ever running while one is open)
  // run/break if that same row no longer exists in the new response,
  // rather than unconditionally clearing every selection.
  const loadDaily = useCallback(
    (opts: { background?: boolean } = {}) => {
      if (!selectedEmployeeId) return Promise.resolve();
      const background = opts.background ?? false;

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const requestId = ++requestSeqRef.current;
      const isCurrent = () => isMountedRef.current && requestId === requestSeqRef.current;

      if (background) setRefreshing(true);

      return api<DailyInputsResponse>(
        `/api/inputs/daily?employeeId=${encodeURIComponent(selectedEmployeeId)}&date=${encodeURIComponent(date)}`,
        { signal: controller.signal }
      )
        .then((res) => {
          if (!isCurrent()) return;
          setDaily(res);
          setError(null);
          setStale(false);
          setLastUpdatedAt(new Date());
          if (background) {
            setSelectedRunId((prev) => (prev && res.runs.some((r) => r.id === prev) ? prev : null));
            setSelectedBreakId((prev) => (prev && res.breaks.some((b) => b.id === prev) ? prev : null));
          } else {
            // Server truth just replaced everything derived — never keep a
            // selection or in-flight edit pointed at a row that may have
            // moved, merged, or disappeared as a result of the change that
            // triggered this reload.
            setSelectedRunId(null);
            setEditingRunId(null);
            setSelectedBreakId(null);
            setEditingBreak(null);
            setEditingWorkStart(false);
          }
        })
        .catch((err) => {
          if (!isCurrent()) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (background) {
            setStale(true);
          } else {
            setDaily(null);
            setError(err instanceof ApiError ? err.message : "Could not load activity logs");
          }
        })
        .finally(() => {
          if (isCurrent()) setRefreshing(false);
        });
    },
    [selectedEmployeeId, date]
  );

  // Keeps pausedRef current every render, and fires one immediate
  // background refresh on the falling edge (was paused, now isn't) — the
  // moment an edit is cancelled/saved or a modal closes, rather than
  // waiting up to POLL_INTERVAL_MS for the next natural trigger. A
  // successful direct save already triggers its own explicit reload in the
  // handler that made it, so this mainly covers a plain Cancel out of an
  // edit (or a save that failed validation, which never reaches its own
  // reload).
  useEffect(() => {
    const nowPaused =
      editingRunId !== null ||
      editingBreak !== null ||
      editingWorkStart ||
      actionInFlight ||
      pendingDeletion !== null ||
      deletionSubmitting;
    const wasPaused = pausedRef.current;
    pausedRef.current = nowPaused;
    if (wasPaused && !nowPaused) {
      loadDaily({ background: true });
    }
  }, [
    editingRunId,
    editingBreak,
    editingWorkStart,
    actionInFlight,
    pendingDeletion,
    deletionSubmitting,
    loadDaily,
  ]);

  useEffect(() => {
    // A fresh load triggered by an employee/date navigation change (this
    // effect's only trigger, since loadDaily's identity only changes with
    // those two deps) — any success banner or action-error left over from a
    // previous action no longer applies to what's about to be shown.
    setSuccessMessage(null);
    setActionError(null);
    loadDaily();
  }, [loadDaily]);

  // Requirement 2's remaining "refresh immediately" triggers: tab becomes
  // visible, window regains focus, network reconnects. The employee/date
  // triggers are already covered by the effect above (loadDaily's own
  // deps), and the correction/deletion triggers by their own handlers
  // calling loadDaily() directly. Each background tick is skipped while
  // pausedRef is set — never interrupts an active edit or open modal — and
  // resumes on its own on the very next interval/visibility/focus/online
  // event once that clears, with no separate "resume" call needed.
  useEffect(() => {
    if (!selectedEmployeeId) return;

    function backgroundRefresh() {
      if (pausedRef.current) return;
      loadDaily({ background: true });
    }
    function handleVisibility() {
      if (document.visibilityState === "visible") backgroundRefresh();
    }
    function handleOffline() {
      setStale(true);
    }

    const interval = window.setInterval(backgroundRefresh, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", backgroundRefresh);
    window.addEventListener("online", backgroundRefresh);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", backgroundRefresh);
      window.removeEventListener("online", backgroundRefresh);
      window.removeEventListener("offline", handleOffline);
    };
  }, [selectedEmployeeId, loadDaily]);

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

  async function handleSaveEdit() {
    if (!editingRunId || !daily || !editTimeValue) return;
    const run = daily.runs.find((r) => r.id === editingRunId);
    if (!run) return;
    const newEndTimeIso = combineDateAndTimeToUtcIso(date, editTimeValue);
    setEditingRunId(null);
    setActionInFlight(true);
    setActionError(null);
    try {
      await api(`/api/inputs/activity-runs/${run.id}/end-time`, {
        method: "PATCH",
        body: JSON.stringify({ endTime: newEndTimeIso }),
      });
      await loadDaily();
      setSuccessMessage("End time updated.");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save the correction");
    } finally {
      setActionInFlight(false);
    }
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

  async function handleSaveEditBreak() {
    if (!editingBreak || !daily || !editBreakTimeValue) return;
    const brk = daily.breaks.find((b) => b.id === editingBreak.id);
    if (!brk) return;
    const { field } = editingBreak;
    const newTimeIso = combineDateAndTimeToUtcIso(date, editBreakTimeValue);
    setEditingBreak(null);
    setActionInFlight(true);
    setActionError(null);
    try {
      await api(`/api/inputs/breaks/${brk.id}`, {
        method: "PATCH",
        body: JSON.stringify(field === "start" ? { startTime: newTimeIso } : { endTime: newTimeIso }),
      });
      await loadDaily();
      setSuccessMessage("Break updated.");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save the correction");
    } finally {
      setActionInFlight(false);
    }
  }

  function handleStartEditWorkStart() {
    if (!daily || !daily.workStartTime || !daily.canEdit) return;
    setEditingWorkStart(true);
    setEditWorkStartTimeValue(toTimeInputValue(daily.workStartTime));
  }

  function handleCancelEditWorkStart() {
    setEditingWorkStart(false);
  }

  async function handleSaveEditWorkStart() {
    if (!editingWorkStart || !daily || !editWorkStartTimeValue || !selectedEmployeeId) return;
    const newStartIso = combineDateAndTimeToUtcIso(date, editWorkStartTimeValue);
    setEditingWorkStart(false);
    setActionInFlight(true);
    setActionError(null);
    try {
      // Identifies the correction by employeeId/date only — the server
      // independently finds and locks the day's earliest eligible work
      // entry itself rather than trusting a client-supplied entry id (see
      // PATCH /api/inputs/work-start).
      await api("/api/inputs/work-start", {
        method: "PATCH",
        body: JSON.stringify({ employeeId: selectedEmployeeId, date, newStartTime: newStartIso }),
      });
      await loadDaily();
      setSuccessMessage("Work start time updated.");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save the correction");
    } finally {
      setActionInFlight(false);
    }
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
            {selectedEmployeeId && (
              <span className={`inputs-live-status${stale ? " inputs-live-status-stale" : ""}`}>
                {stale
                  ? "Reconnecting…"
                  : refreshing
                  ? "Updating…"
                  : lastUpdatedAt
                  ? `Last updated ${formatClockTime(lastUpdatedAt)}`
                  : "Live"}
              </span>
            )}
          </div>

          {error && <p className="error-text inputs-workspace-placeholder">{error}</p>}
          {actionError && <p className="error-text inputs-workspace-placeholder">{actionError}</p>}
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
                onRowCompletionChanged={() => loadDaily()}
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
                editingWorkStart={editingWorkStart}
                editWorkStartTimeValue={editWorkStartTimeValue}
                onStartEditWorkStart={handleStartEditWorkStart}
                onEditWorkStartTimeChange={setEditWorkStartTimeValue}
                onSaveEditWorkStart={handleSaveEditWorkStart}
                onCancelEditWorkStart={handleCancelEditWorkStart}
              />
            </>
          )}
        </div>
      </div>

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
