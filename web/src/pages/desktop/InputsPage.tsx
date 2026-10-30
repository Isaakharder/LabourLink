import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { DateNav } from "../../components/inputs/DateNav";
import { EmployeeListPanel } from "../../components/inputs/EmployeeListPanel";
import { InputsSkeleton } from "../../components/inputs/InputsSkeleton";
import { ActivityLogsCard, isRunDeletable } from "../../components/inputs/ActivityLogsCard";
import { WorkdayDetailsCard, EditingBreakField, isBreakDeletable } from "../../components/inputs/WorkdayDetailsCard";
import { InputsErrorBoundary } from "../../components/inputs/InputsErrorBoundary";
import { InputsDayTotals } from "../../components/inputs/InputsDayTotals";
import { DeleteTimeEntryModal } from "../../components/inputs/DeleteTimeEntryModal";
import { AddWorkStartModal } from "../../components/inputs/AddWorkStartModal";
import { AddBreakModal } from "../../components/inputs/AddBreakModal";
import { AddActivityModal } from "../../components/inputs/AddActivityModal";
import { AddEmployeeToDayModal } from "../../components/inputs/AddEmployeeToDayModal";
import { SpeedReviewModal } from "../../components/inputs/SpeedReviewModal";
import { SpeedReviewGroupsResponse } from "../../lib/speedReviewTypes";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { ActivityRunDto, BreakDto, DailyInputsResponse, InputsEmployee, InputsWorkingTotals } from "../../lib/inputsTypes";
import {
  APP_TIMEZONE,
  combineDateAndTimeToUtcIso,
  formatDateLong,
  formatTimeInAppTimezone,
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

type InputsHeaderStatus = {
  tone: "success" | "warning" | "error";
  message: string;
};

// Every deletion on Inputs goes through one all-or-nothing request, even a
// single row: POST .../activity-runs/bulk-delete or .../breaks/bulk-delete.
interface PendingDeletion {
  kind: "activity-runs" | "breaks";
  employeeId: string;
  // "activity-runs": every run to delete, earliest first.
  runs?: ActivityRunDto[];
  // "breaks": every break to delete, earliest first.
  breaks?: BreakDto[];
  title: string;
  message: string;
  details?: string[];
  confirmLabel: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeBreak(brk: BreakDto): string {
  const end = brk.endedAt ? formatTimeInAppTimezone(brk.endedAt) : "in progress";
  const paid = brk.isPaid === null ? "" : brk.isPaid ? " (paid)" : " (unpaid)";
  return `${brk.name ?? "Break"} — ${formatTimeInAppTimezone(brk.startedAt)} to ${end}${paid}`;
}

function describeRun(run: ActivityRunDto): string {
  const where = [run.row?.label, run.carrier?.name].filter(Boolean).join(" · ");
  const end = run.endedAt ? formatTimeInAppTimezone(run.endedAt) : "in progress";
  return `${run.activityName}${where ? ` (${where})` : ""} — ${formatTimeInAppTimezone(run.startedAt)} to ${end}`;
}

export function InputsPage() {
  const { employee: currentEmployee } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  // The day being viewed belongs to this visit only. Every fresh open of
  // Inputs — app launch, reload, signing in, a restored browser tab, or
  // clicking Inputs in the sidebar — starts at today in the organization's
  // time zone. It is deliberately not kept in the URL or in storage: it used
  // to live in ?date=, which every reload, restored tab and post-login page
  // then read back, reopening Inputs on whatever day was last viewed.
  // There is no dated deep link into Inputs; a ?date= left in an old URL or
  // bookmark is ignored and removed below.
  const [date, setDate] = useState(() => todayInAppTimezone());
  const selectedEmployeeId = searchParams.get("employee");

  useEffect(() => {
    if (!searchParams.has("date")) return;
    const params = new URLSearchParams(searchParams);
    params.delete("date");
    setSearchParams(params, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clicking Inputs in the sidebar while already on Inputs is a fresh open
  // too (NavItem marks main-navigation clicks). Any other location change —
  // picking an employee, which rewrites ?employee= — keeps the chosen day.
  const locationKeyRef = useRef(location.key);
  useEffect(() => {
    if (location.key === locationKeyRef.current) return;
    locationKeyRef.current = location.key;
    if ((location.state as { fromMainNav?: boolean } | null)?.fromMainNav) setDate(todayInAppTimezone());
  }, [location.key, location.state]);

  const [employees, setEmployees] = useState<InputsEmployee[] | null>(null);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  // True while a request for the CURRENTLY selected date/search is in
  // flight — distinct from `employees === null` (first-ever load, panel
  // shows its own "Loading..." text). Once the roster has loaded once,
  // EmployeeListPanel uses this instead to show a placeholder in the
  // paid-hours column rather than the previous date's now-possibly-stale
  // numbers while a fresh total is on the way (the roster itself stays put
  // — no full-panel flash, no lost scroll position).
  const [employeesLoading, setEmployeesLoading] = useState(false);
  // Header "Employees working" totals, tagged with the date they're for so a
  // previous date's numbers are never shown after switching dates. They come
  // with every employees response (date-only, ignoring the search), so they
  // refresh on exactly the sidebar's triggers: date change, background poll
  // and every add/edit/delete handler's loadEmployees().
  const [workingTotals, setWorkingTotals] = useState<{ date: string; totals: InputsWorkingTotals } | null>(null);
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
  // Every selected activity row. A plain click selects just that row (and
  // makes it selectedRunId, the row a second click edits); Ctrl/Cmd+click
  // adds or removes a row, for deleting several at once. Always contains
  // selectedRunId when that's set.
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  // Both editable together as one combined correction now (the general
  // Activity Time Correction workflow) — see handleStartEdit/handleSaveEdit.
  const [editStartTimeValue, setEditStartTimeValue] = useState("");
  const [editEndTimeValue, setEditEndTimeValue] = useState("");
  // The run's own values at the moment editing started, captured so
  // handleSaveEdit can tell which field(s) actually changed and send only
  // those to the server — untouched fields are simply omitted, matching
  // the server's own startTime?/endTime? "at least one required" contract.
  const [editOriginalStartIso, setEditOriginalStartIso] = useState<string | null>(null);
  const [editOriginalEndIso, setEditOriginalEndIso] = useState<string | null>(null);

  const [selectedBreakId, setSelectedBreakId] = useState<string | null>(null);
  // Every selected break — same model as selectedRunIds: a plain click
  // selects just that row (and makes it selectedBreakId, the row a second
  // click edits); its checkbox or Ctrl/Cmd+click adds/removes rows.
  const [selectedBreakIds, setSelectedBreakIds] = useState<Set<string>>(new Set());
  const [editingBreak, setEditingBreak] = useState<EditingBreakField | null>(null);
  const [editBreakTimeValue, setEditBreakTimeValue] = useState("");

  const [editingWorkStart, setEditingWorkStart] = useState(false);
  const [editWorkStartTimeValue, setEditWorkStartTimeValue] = useState("");

  // Corrections (activity start/end, break start/end, work start) save
  // directly on Save, Enter, or a click outside the editor — no reason
  // prompt, no confirmation modal (see the
  // removed TimeCorrectionModal). This just covers the brief window a
  // direct save's own request is in flight, for the pause-gate effect
  // below; per-field errors surface through the page's existing `error`
  // banner rather than a modal-local one.
  const [actionInFlight, setActionInFlight] = useState(false);

  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null);
  const [deletionSubmitting, setDeletionSubmitting] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);

  // Which "Add …" modal (if any) is currently open — at most one at a time,
  // opened from either section header bar. Included in the pause-gate
  // effect below (same as pendingDeletion) so background polling can't
  // yank the page out from under an admin mid-entry.
  const [addModal, setAddModal] = useState<"work-start" | "break" | "activity" | null>(null);
  // "Add employee to this day" (the sidebar's + button). Separate from
  // addModal because it isn't tied to the selected employee: the employee
  // switch it ends with must not close it mid-save, and it needs no `daily`.
  // Same roles as the server's manual-entry routes (EDIT_ROLES).
  const canAddEmployeeToDay =
    currentEmployee?.securityRole === "Administrator" ||
    currentEmployee?.securityRole === "Manager" ||
    currentEmployee?.securityRole === "Supervisor";
  const [addEmployeeToDayOpen, setAddEmployeeToDayOpen] = useState(false);
  // Success message to show once the employee switch that follows a save has
  // happened — that switch's reset effect clears successMessage itself.
  const pendingSuccessMessageRef = useRef<string | null>(null);
  // The modal records work for the date it was opened on; never let it
  // carry over to a different date.
  useEffect(() => {
    setAddEmployeeToDayOpen(false);
  }, [date]);

  // Bulk speed review (SpeedReviewModal). Viewing the review groups needs
  // the same roles as the individual review modal's candidate list
  // (Administrator/Manager); saving completions is Administrator-only,
  // same as the individual Combine. `reviewModal.employeeId === null` is
  // "Review all employees".
  const canReviewSpeeds = currentEmployee?.securityRole === "Administrator" || currentEmployee?.securityRole === "Manager";
  const canApplySpeedReview = currentEmployee?.securityRole === "Administrator";
  const [reviewModal, setReviewModal] = useState<{ employeeId: string | null } | null>(null);
  // Pending review groups for `date`: total and per employee — the badges on
  // "Review all employees" and "Review speeds". null until loaded (no badge
  // shown rather than a misleading 0).
  const [reviewCounts, setReviewCounts] = useState<{ total: number; byEmployee: Map<string, number> } | null>(null);

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
  // Set whenever a FOREGROUND (explicit, non-background) loadDaily call
  // lands successfully while the page is paused (mid-edit/mid-submit) — a
  // delete/correction handler's own "await loadDaily()" after its mutation
  // succeeds is exactly this case. Checked (and cleared) by the falling-edge
  // effect just below: without it, that effect's own "fire one background
  // refresh the moment paused goes false" would double up with the reload
  // the handler that just unpaused things already did itself, one call
  // after the other — this is what keeps it to the one reload the handler
  // performed, not two.
  const explicitReloadDuringPauseRef = useRef(false);
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
    if (next.date !== undefined) setDate(next.date);
    if (next.employee !== undefined) {
      const params = new URLSearchParams(searchParams);
      params.set("employee", next.employee);
      setSearchParams(params, { replace: true });
    }
  }

  // Scoped to `date` — the panel lists whoever has an actual time-entry log
  // on the selected date (server-side, see GET /api/inputs/employees),
  // never every active employee regardless of whether they worked that day.
  // Re-runs on every date navigation, same as loadDaily. The response also
  // carries each employee's paidSeconds for `date` (same authoritative
  // workedSeconds workdayTotals.ts computes for the Daily view and
  // Payroll), shown as the row's H:MM total — `date` is always sent as an
  // explicit query param and validated server-side (GET /api/inputs/employees
  // 400s on a missing/malformed one), so what's displayed can never
  // silently drift from what DateNav shows as selected.
  const employeesRequestSeqRef = useRef(0);
  // Mirrors loadDaily's own abortControllerRef immediately below — aborting
  // whatever employees request was still in flight before starting a new
  // one means at most one is ever genuinely in flight at a time, covering
  // both a rapid date/search change AND the background poll/visibility/
  // focus/online triggers (see the effect further down) landing close
  // together. The requestId check in each callback below is the actual
  // correctness guarantee (an already-past-fetch() request can still
  // resolve after being aborted) — the abort itself is the "don't even let
  // it finish" optimization on top.
  const employeesAbortControllerRef = useRef<AbortController | null>(null);

  // Review-count badges for `date`, from the same server grouping the
  // review popup shows (GET /api/row-completions/review-groups, every
  // employee). Refreshed on exactly the sidebar's own triggers — called from
  // loadEmployees below, so every date change, background poll and
  // post-save refresh that updates paid hours updates these too. A failed
  // refresh keeps the last known counts (same as a background employees
  // refresh); a newer request always wins over an older one.
  const reviewCountsSeqRef = useRef(0);
  const reviewCountsDateRef = useRef<string | null>(null);
  const loadReviewCounts = useCallback(() => {
    if (!canReviewSpeeds) return;
    const requestId = ++reviewCountsSeqRef.current;
    // A different date's counts must never stay on screen while the new
    // date's are loading.
    if (reviewCountsDateRef.current !== date) setReviewCounts(null);
    api<SpeedReviewGroupsResponse>(`/api/row-completions/review-groups?date=${encodeURIComponent(date)}`)
      .then((res) => {
        if (requestId !== reviewCountsSeqRef.current) return;
        const byEmployee = new Map<string, number>();
        for (const g of res.groups) byEmployee.set(g.employeeId, (byEmployee.get(g.employeeId) ?? 0) + 1);
        reviewCountsDateRef.current = date;
        setReviewCounts({ total: res.groups.length, byEmployee });
      })
      .catch(() => {
        // Keep the last known counts; the next refresh trigger retries.
      });
  }, [date, canReviewSpeeds]);
  // `background: true` marks a poll/visibility/focus/online-triggered
  // refresh, same convention as loadDaily's own `opts.background`: it never
  // flips employeesLoading (so the sidebar doesn't flash its placeholder
  // bars every 10 seconds) and a failure never shows the error banner or
  // blanks an already-loaded roster — it just leaves the last known totals
  // in place until the next successful refresh. A foreground call (initial
  // load, or an explicit date/search change) keeps showing the loading
  // placeholder and surfaces a real failure normally.
  const loadEmployees = useCallback((opts: { background?: boolean } = {}) => {
    const background = opts.background ?? false;
    const params = new URLSearchParams();
    params.set("date", date);
    if (employeeSearch.trim()) params.set("search", employeeSearch.trim());

    employeesAbortControllerRef.current?.abort();
    const controller = new AbortController();
    employeesAbortControllerRef.current = controller;

    const requestId = ++employeesRequestSeqRef.current;
    if (!background) setEmployeesLoading(true);
    loadReviewCounts();
    api<{ employees: InputsEmployee[]; workingTotals?: InputsWorkingTotals }>(`/api/inputs/employees?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (requestId !== employeesRequestSeqRef.current) return;
        setEmployees(res.employees);
        setEmployeesError(null);
        if (res.workingTotals) setWorkingTotals({ date, totals: res.workingTotals });
      })
      .catch((err) => {
        if (requestId !== employeesRequestSeqRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!background) {
          setEmployeesError(err instanceof ApiError ? err.message : "Could not load employees");
        }
      })
      .finally(() => {
        if (requestId !== employeesRequestSeqRef.current) return;
        if (!background) setEmployeesLoading(false);
      });
  }, [employeeSearch, date, loadReviewCounts]);

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
    updateParams({ employee: (signedIn ?? employees[0]).id });
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
            setSelectedRunIds((prev) => {
              const still = [...prev].filter((id) => res.runs.some((r) => r.id === id));
              return still.length === prev.size ? prev : new Set(still);
            });
            setSelectedBreakId((prev) => (prev && res.breaks.some((b) => b.id === prev) ? prev : null));
            setSelectedBreakIds((prev) => {
              const still = [...prev].filter((id) => res.breaks.some((b) => b.id === id));
              return still.length === prev.size ? prev : new Set(still);
            });
          } else {
            // This explicit reload landed while the page was still paused
            // (mid-delete/mid-correction) — the falling-edge effect below is
            // about to fire its own "unpaused, refresh once" the moment that
            // pause clears a few state updates from now; flagging that this
            // handler already reloaded lets it skip its own redundant one.
            if (pausedRef.current) explicitReloadDuringPauseRef.current = true;
            // Server truth just replaced everything derived — never keep a
            // selection or in-flight edit pointed at a row that may have
            // moved, merged, or disappeared as a result of the change that
            // triggered this reload.
            setSelectedRunId(null);
            setSelectedRunIds(new Set());
            setEditingRunId(null);
            setSelectedBreakId(null);
            setSelectedBreakIds(new Set());
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
  // successful direct save/delete already triggers its own explicit reload
  // in the handler that made it (e.g. handleConfirmDeletion's own "await
  // loadDaily()") — without the explicitReloadDuringPauseRef check below,
  // THIS effect would then fire a second, redundant background reload right
  // after (deletionSubmitting/actionInFlight flipping back to false is
  // itself a falling edge), one network round trip after the other, for
  // every successful save/delete. The check skips that specific case
  // (something already reloaded while paused) while still covering what
  // this effect actually exists for: a plain Cancel out of an edit, or a
  // save that failed validation before ever reaching its own reload —
  // neither of which sets the flag, so this still fires normally for those.
  useEffect(() => {
    const nowPaused =
      editingRunId !== null ||
      editingBreak !== null ||
      editingWorkStart ||
      actionInFlight ||
      pendingDeletion !== null ||
      deletionSubmitting ||
      addModal !== null ||
      addEmployeeToDayOpen ||
      reviewModal !== null;
    const wasPaused = pausedRef.current;
    pausedRef.current = nowPaused;
    if (wasPaused && !nowPaused) {
      if (explicitReloadDuringPauseRef.current) {
        explicitReloadDuringPauseRef.current = false;
      } else {
        loadDaily({ background: true });
      }
    }
  }, [
    editingRunId,
    editingBreak,
    editingWorkStart,
    actionInFlight,
    pendingDeletion,
    deletionSubmitting,
    addModal,
    addEmployeeToDayOpen,
    reviewModal,
    loadDaily,
  ]);

  useEffect(() => {
    // A fresh load triggered by an employee/date navigation change (this
    // effect's only trigger, since loadDaily's identity only changes with
    // those two deps) — any success banner or action-error left over from a
    // previous action no longer applies to what's about to be shown.
    setSuccessMessage(pendingSuccessMessageRef.current);
    pendingSuccessMessageRef.current = null;
    setActionError(null);
    // Immediately stop displaying the previous employee's data — `daily`
    // is cleared synchronously, before loadDaily's request even starts, so
    // the render below falls through to InputsSkeleton rather than
    // continuing to show a switched-away-from employee's real (and, for a
    // payroll-sensitive page, potentially misleading) numbers for however
    // long the new request takes. Every in-progress edit/modal is closed
    // for the same reason: each editing surface (AddWorkStartModal,
    // AddBreakModal, AddActivityModal, the inline run/break/work-start
    // editors) captures the employeeId it's acting on as of when it
    // opened — leaving one open across a switch would let it keep acting
    // on the employee the page just navigated away from. This is the same
    // reset loadDaily's own non-background success handler already does
    // once the response lands; doing it here too means it also covers the
    // gap while the request is still in flight, not just after.
    setDaily(null);
    setSelectedRunId(null);
    setSelectedRunIds(new Set());
    setEditingRunId(null);
    setSelectedBreakId(null);
    setSelectedBreakIds(new Set());
    setEditingBreak(null);
    setEditingWorkStart(false);
    setAddModal(null);
    setPendingDeletion(null);
    setReviewModal(null);
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
      // Keeps the sidebar's paid-hours totals current through the exact
      // same poll/visibility/focus/online triggers as the detail view —
      // in particular, an employee still mid-shift (an open work entry)
      // needs this to keep climbing rather than freezing at whatever it
      // read on the last foreground load. No separate timer: this reuses
      // the interval/listeners already set up below, and loadEmployees'
      // own abort-the-previous-request handling (see its definition above)
      // means this can never pile up a second concurrent request on top of
      // one already in flight from a rapid date change or another trigger
      // firing moments earlier.
      loadEmployees({ background: true });
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
  }, [selectedEmployeeId, loadDaily, loadEmployees]);

  // additive = Ctrl/Cmd held: toggle this row in or out of the selection
  // instead of replacing it. Multi-selecting closes any open time editor —
  // editing is a single-row action.
  function handleSelectRun(id: string, additive = false) {
    if (!additive) {
      setSelectedRunId(id);
      setSelectedRunIds(new Set([id]));
      if (editingRunId && editingRunId !== id) setEditingRunId(null);
      return;
    }
    setEditingRunId(null);
    const next = new Set(selectedRunIds);
    if (selectedRunId) next.add(selectedRunId);
    if (next.has(id)) {
      next.delete(id);
      if (selectedRunId === id) setSelectedRunId(next.size > 0 ? [...next][next.size - 1] : null);
    } else {
      next.add(id);
      setSelectedRunId(id);
    }
    setSelectedRunIds(next);
  }

  // Header "select all" checkbox: exactly these rows (all visible deletable
  // ones, or none). Editing is a single-row action, so any open editor closes.
  function handleSetSelectedRuns(ids: string[]) {
    setEditingRunId(null);
    setSelectedRunIds(new Set(ids));
    setSelectedRunId(ids.length > 0 ? ids[ids.length - 1] : null);
  }

  // Enters ONE combined edit mode covering both Start Time and End Time —
  // clicking either cell gets here (see ActivityLogsCard's handleTimeCellClick)
  // so an admin can correct either boundary, or both, in a single Save.
  function handleStartEdit(run: ActivityRunDto) {
    if (!run.canEdit || !run.endedAt) return;
    setEditingRunId(run.id);
    setEditStartTimeValue(toTimeInputValue(run.startedAt));
    setEditEndTimeValue(toTimeInputValue(run.endedAt));
    setEditOriginalStartIso(run.startedAt);
    setEditOriginalEndIso(run.endedAt);
  }

  function handleCancelEdit() {
    setEditingRunId(null);
  }

  // Saves on Enter, Save, or a click anywhere outside the editor — directly,
  // with no confirmation popup.
  async function handleSaveEdit() {
    if (!editingRunId || !daily) return;
    const run = daily.runs.find((r) => r.id === editingRunId);
    if (!run) return;
    // A cleared or partly typed time leaves the editor open with an
    // explanation rather than silently dropping the edit.
    if (!editStartTimeValue || !editEndTimeValue) {
      setSuccessMessage(null);
      setActionError("Enter a complete start and end time, or press Esc to cancel.");
      return;
    }
    const newStartIso = combineDateAndTimeToUtcIso(date, editStartTimeValue);
    const newEndIso = combineDateAndTimeToUtcIso(date, editEndTimeValue);
    // Only the field(s) that actually changed are sent — matching the
    // server's own startTime?/endTime? "at least one required" contract,
    // and letting a start-only or end-only edit stay exactly that instead
    // of re-asserting an unchanged boundary as if the admin had retyped it.
    const startTime = newStartIso !== editOriginalStartIso ? newStartIso : undefined;
    const endTime = newEndIso !== editOriginalEndIso ? newEndIso : undefined;
    setEditingRunId(null);
    setActionError(null);
    if (startTime === undefined && endTime === undefined) return;
    setActionInFlight(true);
    try {
      // The server validates the correction and computes its plan (which
      // may trim, split or remove neighbouring entries) in the preview; the
      // PATCH must echo the plan's fingerprint and is rejected if the day
      // changed in between. Previously the plan was shown in a "Confirm
      // activity correction" popup first — it's now applied straight away,
      // the same way break corrections already were.
      const { fingerprint } = await api<{ messages: string[]; fingerprint: string }>(
        `/api/inputs/activity-runs/${run.id}/correction-preview`,
        { method: "POST", body: JSON.stringify({ startTime, endTime }) }
      );
      await api(`/api/inputs/activity-runs/${run.id}/correction`, {
        method: "PATCH",
        body: JSON.stringify({ startTime, endTime, fingerprint }),
      });
      await loadDaily();
      // The correction may have moved this employee's paid-hours total —
      // refresh the sidebar row alongside the detail view rather than
      // leaving it showing the pre-correction number until the next date
      // switch. Fire-and-forget: it manages its own employees/employeesError
      // state independently of loadDaily's.
      loadEmployees();
      setSuccessMessage("Activity time updated.");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save the correction");
    } finally {
      setActionInFlight(false);
    }
  }

  // Same additive model as handleSelectRun above.
  function handleSelectBreak(id: string, additive = false) {
    if (!additive) {
      setSelectedBreakId(id);
      setSelectedBreakIds(new Set([id]));
      if (editingBreak && editingBreak.id !== id) setEditingBreak(null);
      return;
    }
    setEditingBreak(null);
    const next = new Set(selectedBreakIds);
    if (selectedBreakId) next.add(selectedBreakId);
    if (next.has(id)) {
      next.delete(id);
      if (selectedBreakId === id) setSelectedBreakId(next.size > 0 ? [...next][next.size - 1] : null);
    } else {
      next.add(id);
      setSelectedBreakId(id);
    }
    setSelectedBreakIds(next);
  }

  function handleSetSelectedBreaks(ids: string[]) {
    setEditingBreak(null);
    setSelectedBreakIds(new Set(ids));
    setSelectedBreakId(ids.length > 0 ? ids[ids.length - 1] : null);
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
    if (!editingBreak || !daily) return;
    const brk = daily.breaks.find((b) => b.id === editingBreak.id);
    if (!brk) return;
    if (!editBreakTimeValue) {
      setSuccessMessage(null);
      setActionError("Enter a complete break time, or press Esc to cancel.");
      return;
    }
    const { field } = editingBreak;
    const newTimeIso = combineDateAndTimeToUtcIso(date, editBreakTimeValue);
    setEditingBreak(null);
    // Saves directly on Save, Enter or a click outside the editor, with no
    // confirmation popup — even when the
    // new time trims, splits or removes a neighbouring activity entry. The
    // server's PATCH computes and applies that same adjustment itself
    // (computeBreakCorrectionPlan, the plan the old preview popup only
    // displayed), so skipping the popup changes nothing about what's saved.
    await applyBreakCorrection(brk.id, field, newTimeIso);
  }

  async function applyBreakCorrection(breakId: string, field: "start" | "end", newTimeIso: string) {
    setActionInFlight(true);
    setActionError(null);
    try {
      await api(`/api/inputs/breaks/${breakId}`, {
        method: "PATCH",
        body: JSON.stringify(field === "start" ? { startTime: newTimeIso } : { endTime: newTimeIso }),
      });
      await loadDaily();
      // See applyActivityRunCorrection's own comment — a break correction
      // (paid<->unpaid boundary moved, or reclassified) can change this
      // employee's paid-hours total just as much as an activity correction.
      loadEmployees();
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
    if (!editingWorkStart || !daily || !selectedEmployeeId) return;
    if (!editWorkStartTimeValue) {
      setSuccessMessage(null);
      setActionError("Enter a complete work start time, or press Esc to cancel.");
      return;
    }
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
      // See applyActivityRunCorrection's own comment.
      loadEmployees();
      setSuccessMessage("Work start time updated.");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save the correction");
    } finally {
      setActionInFlight(false);
    }
  }

  // Header Delete (Activity details): every selected finished log, earliest
  // first, in one confirmation and one all-or-nothing request. Selected
  // in-progress logs (only reachable via a plain row click — they have no
  // checkbox) are left out and called out in the dialog.
  function handleDeleteSelectedRuns() {
    if (!daily) return;
    const chosen = daily.runs.filter((r) => selectedRunIds.has(r.id));
    const deletable = chosen.filter(isRunDeletable).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (deletable.length === 0) return;
    const skipped = chosen.length - deletable.length;
    const n = deletable.length;
    const name = `${daily.employee.firstName} ${daily.employee.lastName}`;
    setDeletionError(null);
    setPendingDeletion({
      kind: "activity-runs",
      employeeId: daily.employee.id,
      runs: deletable,
      title: `Delete ${plural(n, "activity entry", "activity entries")}?`,
      message:
        `This changes ${name}'s Inputs record for ${formatDateLong(daily.date)}: ` +
        `${n === 1 ? "this activity is" : `these ${n} activities are`} removed from the day` +
        `${n === 1 ? "" : ", all together or not at all"}. The work that follows fills each gap, ` +
        "worked time and speeds are recalculated, and every deletion stays in the audit history." +
        (skipped > 0 ? ` ${skipped} selected in-progress ${skipped === 1 ? "activity is" : "activities are"} not included.` : ""),
      details: deletable.map(describeRun),
      confirmLabel: `Delete ${plural(n, "entry", "entries")}`,
    });
  }

  // Header Delete (Workday details): every selected finished break. Work
  // start and the Total break time row are never part of the selection.
  function handleDeleteSelectedBreaks() {
    if (!daily) return;
    const deletable = daily.breaks
      .filter((b) => selectedBreakIds.has(b.id) && isBreakDeletable(b))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (deletable.length === 0) return;
    const n = deletable.length;
    const name = `${daily.employee.firstName} ${daily.employee.lastName}`;
    setDeletionError(null);
    setPendingDeletion({
      kind: "breaks",
      employeeId: daily.employee.id,
      breaks: deletable,
      title: `Delete ${plural(n, "break", "breaks")}?`,
      message:
        `This changes ${name}'s Inputs record for ${formatDateLong(daily.date)}: ` +
        `${n === 1 ? "this break is" : `these ${n} breaks are`} removed` +
        `${n === 1 ? "" : ", all together or not at all"}, and the surrounding work time is reconnected. ` +
        "Paid and unpaid break totals update straight away, and every deletion stays in the audit history.",
      details: deletable.map(describeBreak),
      confirmLabel: `Delete ${plural(n, "break", "breaks")}`,
    });
  }

  async function handleConfirmDeletion() {
    // Belt-and-suspenders against a double-fire (e.g. a fast repeat Enter):
    // the modal's own submit guard already disables the button while
    // submitting, this just makes the same guarantee at the handler level.
    if (!pendingDeletion || deletionSubmitting) return;
    setDeletionSubmitting(true);
    setDeletionError(null);
    const pending = pendingDeletion;
    try {
      let successMessage: string;
      if (pending.kind === "activity-runs") {
        // Each log is sent exactly as loaded (its own segment ids), so the
        // server deletes precisely what was selected — never an unselected
        // neighbour that an earlier deletion made join the same run — or,
        // if anything changed, nothing at all.
        const runs = pending.runs ?? [];
        await api("/api/inputs/activity-runs/bulk-delete", {
          method: "POST",
          body: JSON.stringify({ employeeId: pending.employeeId, runs: runs.map((r) => r.segmentIds) }),
        });
        successMessage = `${plural(runs.length, "activity entry", "activity entries")} deleted.`;
      } else {
        // Each break is sent with the times shown on screen, so a break
        // re-timed elsewhere since this page loaded refuses the request.
        const breaks = pending.breaks ?? [];
        await api("/api/inputs/breaks/bulk-delete", {
          method: "POST",
          body: JSON.stringify({
            employeeId: pending.employeeId,
            breaks: breaks.map((b) => ({ id: b.id, startedAt: b.startedAt, endedAt: b.endedAt })),
          }),
        });
        successMessage = `${plural(breaks.length, "break", "breaks")} deleted.`;
      }
      setPendingDeletion(null);
      // Reload while still marked as submitting, so the page's pause logic
      // doesn't fire a second, redundant background reload right after.
      // This non-background reload also clears every selection.
      await loadDaily();
      // See applyActivityRunCorrection's own comment — refreshes the
      // sidebar's paid hours, the working totals and review badges too.
      loadEmployees();
      setSuccessMessage(successMessage);
    } catch (err) {
      const fallback = pending.kind === "activity-runs" ? "Could not delete the selected activity entries" : "Could not delete the selected breaks";
      const message = err instanceof ApiError ? err.message : fallback;
      setDeletionError(/nothing was deleted/i.test(message) ? message : `Nothing was deleted. ${message}`);
    } finally {
      setDeletionSubmitting(false);
    }
  }

  function handleCancelDeletion() {
    if (deletionSubmitting) return;
    setPendingDeletion(null);
    setDeletionError(null);
  }

  async function handleManualEntryCreated(message: string) {
    setAddModal(null);
    await loadDaily();
    // See applyActivityRunCorrection's own comment — covers Add work start /
    // Add break / Add activity, all of which can add paid time.
    loadEmployees();
    setSuccessMessage(message);
  }

  // After "Add employee to this day" saves: show and select that employee so
  // further activities/breaks can be added from their day as usual. The
  // search box is cleared so the new row can't be filtered out of view.
  async function handleEmployeeAddedToDay(employee: { id: string; name: string }, duplicate: boolean) {
    setAddEmployeeToDayOpen(false);
    setEmployeeSearch("");
    const message = duplicate ? `${employee.name}'s work entry was already saved.` : `${employee.name} added to this day.`;
    if (employee.id === selectedEmployeeId) {
      await loadDaily();
      loadEmployees();
      setSuccessMessage(message);
    } else {
      // The switch below reloads the day (loadDaily's reset effect) and the
      // employee list (loadEmployees re-runs from the cleared search).
      pendingSuccessMessageRef.current = message;
      updateParams({ employee: employee.id });
      if (!employeeSearch) loadEmployees();
    }
  }

  const activityHeaderStatus: InputsHeaderStatus | null = actionError
    ? { tone: "error", message: actionError }
    : error
    ? { tone: "error", message: error }
    : successMessage
    ? { tone: "success", message: successMessage }
    : null;

  const activityHeaderStatusClassName = activityHeaderStatus
    ? activityHeaderStatus.tone === "error"
      ? "error-text"
      : activityHeaderStatus.tone === "warning"
      ? "warning-text"
      : "success-text"
    : null;

  // Header Delete count for Activity details — only selected rows the
  // server will actually accept count (an in-progress row selected by a
  // plain click is ignored).
  const selectedDeletableRunCount = daily ? daily.runs.filter((r) => selectedRunIds.has(r.id) && isRunDeletable(r)).length : 0;

  return (
    <div className="inputs-page">
      <PageHeader
        title="Inputs"
        description="Review and correct daily employee activity logs."
        titleAside={<InputsDayTotals totals={workingTotals?.date === date ? workingTotals.totals : null} />}
      />

      <div className="inputs-workspace">
        <EmployeeListPanel
          employees={employees}
          error={employeesError}
          loading={employeesLoading}
          selectedId={selectedEmployeeId}
          onSelect={(id) => updateParams({ employee: id })}
          search={employeeSearch}
          onSearchChange={setEmployeeSearch}
          headerAction={
            canReviewSpeeds || canAddEmployeeToDay ? (
              <div className="inputs-employee-header-actions">
                {canReviewSpeeds && (
                  <button
                    type="button"
                    className="inputs-section-header-button inputs-review-button inputs-employee-review-all"
                    onClick={() => setReviewModal({ employeeId: null })}
                  >
                    Review all employees
                    <ReviewCountBadge count={reviewCounts?.total ?? null} label="pending speed reviews for all employees" />
                  </button>
                )}
                {canAddEmployeeToDay && (
                  <button
                    type="button"
                    className="inputs-section-header-button inputs-add-employee-button"
                    title="Add employee to this day"
                    aria-label="Add employee to this day"
                    onClick={() => setAddEmployeeToDayOpen(true)}
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                )}
              </div>
            ) : null
          }
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

          {selectedEmployeeId && (
            <div className="inputs-section-header inputs-section-header-with-status">
              <h3>Activity details</h3>
              {canReviewSpeeds && (
                <button
                  type="button"
                  className="inputs-section-header-button inputs-review-button"
                  onClick={() => setReviewModal({ employeeId: selectedEmployeeId })}
                >
                  Review speeds
                  <ReviewCountBadge
                    count={reviewCounts ? reviewCounts.byEmployee.get(selectedEmployeeId) ?? 0 : null}
                    label="pending speed reviews for this employee"
                  />
                </button>
              )}
              <div className="inputs-section-header-status">
                {activityHeaderStatus && activityHeaderStatusClassName && (
                  <p
                    className={`inputs-section-header-status-text ${activityHeaderStatusClassName}`}
                    title={activityHeaderStatus.message}
                    role={activityHeaderStatus.tone === "error" ? "alert" : "status"}
                    aria-live={activityHeaderStatus.tone === "error" ? "assertive" : "polite"}
                  >
                    {activityHeaderStatus.message}
                  </p>
                )}
              </div>
              <div className="inputs-section-header-actions">
                {daily?.canEdit && (
                  <button type="button" className="inputs-section-header-button" onClick={() => setAddModal("activity")}>
                    Add activity
                  </button>
                )}
                {daily?.canEdit && (
                  <button
                    type="button"
                    className="inputs-section-header-button inputs-section-header-button-danger"
                    disabled={selectedDeletableRunCount === 0}
                    title={selectedDeletableRunCount === 0 ? "Select one or more activity entries to delete" : undefined}
                    onClick={handleDeleteSelectedRuns}
                  >
                    {selectedDeletableRunCount === 0 ? "Delete" : `Delete (${selectedDeletableRunCount})`}
                  </button>
                )}
              </div>
            </div>
          )}

          {!selectedEmployeeId ? (
            employeesError ? null : (
              <p className="placeholder-page inputs-workspace-placeholder">
                Select an employee to view their activity logs.
              </p>
            )
          ) : !daily ? (
            // No skeleton once a foreground load has actually failed (the
            // error banner above already covers that) — only while a
            // request for the current employee/date is genuinely still in
            // flight.
            !error && (
              <InputsSkeleton employee={employees?.find((e) => e.id === selectedEmployeeId) ?? null} />
            )
          ) : (
            <InputsErrorBoundary
              resetKey={`${selectedEmployeeId}:${date}`}
              label="Inputs daily detail"
              renderFallback={(diagnosticId) => (
                <div className="inputs-needs-review" role="alert">
                  <p className="inputs-needs-review-title">Needs review</p>
                  <p className="inputs-needs-review-detail">
                    This day's activity logs couldn't be displayed due to an unexpected data issue. Date navigation,
                    the employee list, and other admin controls are still usable — try a different date, or contact
                    support with this reference.
                  </p>
                  <p className="inputs-needs-review-ref">Reference: {diagnosticId}</p>
                </div>
              )}
            >
              <ActivityLogsCard
                employee={daily.employee}
                date={daily.date}
                runs={daily.runs}
                totals={daily.totals}
                selectedRunId={selectedRunId}
                selectedRunIds={selectedRunIds}
                onSelectRun={handleSelectRun}
                onSetSelectedRuns={daily.canEdit ? handleSetSelectedRuns : undefined}
                editingRunId={editingRunId}
                editStartTimeValue={editStartTimeValue}
                editEndTimeValue={editEndTimeValue}
                onStartEdit={handleStartEdit}
                onEditStartTimeChange={setEditStartTimeValue}
                onEditEndTimeChange={setEditEndTimeValue}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={handleCancelEdit}
                onRowCompletionChanged={() => {
                  loadDaily();
                  // Combining segments doesn't itself move any boundary,
                  // but refreshing here too costs one extra batched request
                  // and keeps this in line with every other "something
                  // about this employee's day just changed" handler above.
                  loadEmployees();
                }}
                saving={actionInFlight}
              />
              <WorkdayDetailsCard
                workStartTime={daily.workStartTime}
                workStartCorrectedFrom={daily.workStartCorrectedFrom}
                workStartManualEntry={daily.workStartManualEntry}
                breaks={daily.breaks}
                paidBreakSeconds={daily.totals.paidBreakSeconds}
                unpaidBreakSeconds={daily.totals.unpaidBreakSeconds}
                selectedBreakId={selectedBreakId}
                selectedBreakIds={selectedBreakIds}
                onSelectBreak={handleSelectBreak}
                onSetSelectedBreaks={daily.canEdit ? handleSetSelectedBreaks : undefined}
                onDeleteSelectedBreaks={daily.canEdit ? handleDeleteSelectedBreaks : undefined}
                editingBreak={editingBreak}
                editBreakTimeValue={editBreakTimeValue}
                onStartEditBreak={handleStartEditBreak}
                onEditBreakTimeChange={setEditBreakTimeValue}
                onSaveEditBreak={handleSaveEditBreak}
                onCancelEditBreak={handleCancelEditBreak}
                editingWorkStart={editingWorkStart}
                editWorkStartTimeValue={editWorkStartTimeValue}
                onStartEditWorkStart={handleStartEditWorkStart}
                onEditWorkStartTimeChange={setEditWorkStartTimeValue}
                onSaveEditWorkStart={handleSaveEditWorkStart}
                onCancelEditWorkStart={handleCancelEditWorkStart}
                onAddWorkStart={daily.canEdit ? () => setAddModal("work-start") : undefined}
                onAddBreak={daily.canEdit ? () => setAddModal("break") : undefined}
              />
            </InputsErrorBoundary>
          )}
        </div>
      </div>

      {pendingDeletion && (
        <DeleteTimeEntryModal
          title={pendingDeletion.title}
          message={pendingDeletion.message}
          details={pendingDeletion.details}
          confirmLabel={pendingDeletion.confirmLabel}
          submitting={deletionSubmitting}
          error={deletionError}
          onConfirm={handleConfirmDeletion}
          onCancel={handleCancelDeletion}
        />
      )}

      {addModal === "work-start" && daily && selectedEmployeeId && (
        <AddWorkStartModal
          employeeId={selectedEmployeeId}
          employeeName={`${daily.employee.firstName} ${daily.employee.lastName}`}
          date={date}
          onClose={() => setAddModal(null)}
          onCreated={() => handleManualEntryCreated("Work start added.")}
        />
      )}
      {addModal === "break" && daily && selectedEmployeeId && (
        <AddBreakModal
          employeeId={selectedEmployeeId}
          employeeName={`${daily.employee.firstName} ${daily.employee.lastName}`}
          date={date}
          runs={daily.runs}
          breaks={daily.breaks}
          workStartTime={daily.workStartTime}
          workEndTime={daily.workEndTime}
          onClose={() => setAddModal(null)}
          onCreated={() => handleManualEntryCreated("Break added.")}
        />
      )}
      {addEmployeeToDayOpen && (
        <AddEmployeeToDayModal
          date={date}
          onClose={() => setAddEmployeeToDayOpen(false)}
          onCreated={handleEmployeeAddedToDay}
        />
      )}
      {reviewModal && (
        <SpeedReviewModal
          date={date}
          employeeId={reviewModal.employeeId}
          employeeName={
            reviewModal.employeeId && daily && daily.employee.id === reviewModal.employeeId
              ? `${daily.employee.firstName} ${daily.employee.lastName}`
              : undefined
          }
          canApply={canApplySpeedReview}
          onClose={() => setReviewModal(null)}
          onApplied={(savedCount) => {
            // Same refresh flow as the individual review's Combine
            // (onRowCompletionChanged): speeds and badges for the selected
            // employee, sidebar totals and review counts. A foreground
            // reload keeps the current employee, date and scroll position.
            loadDaily();
            loadEmployees();
            setSuccessMessage(`Speed review saved — ${savedCount} row${savedCount === 1 ? "" : "s"} updated.`);
          }}
        />
      )}
      {addModal === "activity" && daily && selectedEmployeeId && (
        <AddActivityModal
          employeeId={selectedEmployeeId}
          employeeName={`${daily.employee.firstName} ${daily.employee.lastName}`}
          date={date}
          onClose={() => setAddModal(null)}
          onCreated={() => handleManualEntryCreated("Activity added.")}
        />
      )}
    </div>
  );
}

// Pending-review count on the bulk speed review buttons. Renders nothing
// until counts have loaded (never a misleading 0 while a new date loads).
function ReviewCountBadge({ count, label }: { count: number | null; label: string }) {
  if (count === null) return null;
  return (
    <span className={`inputs-review-count${count === 0 ? " inputs-review-count-zero" : ""}`} aria-label={`${count} ${label}`}>
      {count}
    </span>
  );
}
