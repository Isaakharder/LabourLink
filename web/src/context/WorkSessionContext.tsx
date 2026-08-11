import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useDevicePairing } from "./DevicePairingContext";
import { api, ApiError, getPermanentDeviceAuthErrorCode, isServerUnreachableError } from "../lib/api";
import { getCachedEmployeeSummary } from "../lib/device";
import { enqueue, flushQueue, getPendingCount, isNetworkError } from "../lib/offlineQueue";
import { detectReassignment } from "../lib/reassignment";
import { uuid } from "../lib/uuid";
import { RecentJob } from "../components/mobile/RecentJobsCard";

export interface CurrentActivity {
  id: string;
  name: string;
  startedAt: string;
  // Seconds accumulated across earlier segments of the same continuous job
  // chain (same activity, separated only by breaks) before this entry — the
  // live elapsed time since startedAt is added on top by ActivityTimer.
  accumulatedWorkedSecondsBeforeCurrentEntry: number;
  row: { id: string; label: string } | null;
  carrier: { id: string; name: string } | null;
}

export interface PreviousActivity {
  id: string;
  name: string;
  // Running total for the whole chain up through the segment that just
  // closed when this break started — not just that one segment's length.
  accumulatedWorkedSeconds: number;
}

export interface MeResponse {
  employee: { id: string; firstName: string; lastName: string };
  status: "idle" | "work" | "break";
  currentActivity: CurrentActivity | null;
  since: string | null;
  previousActivity: PreviousActivity | null;
  recentJobs: RecentJob[];
}

// While the server hasn't yet been reached this poll cycle, retry this
// often — only runs while serverReachable is false (see the effect below),
// so a healthy app never has a background timer running at all.
const RECONNECT_POLL_INTERVAL_MS = 15000;

interface PerformOptions {
  pendingLabel?: string;
  // Home-screen-local UI reset (closing the activity picker / question
  // flow sheet) — irrelevant to break/end-day callers, which have no such
  // sheets open when they call perform.
  onResolved?: () => void;
}

interface WorkSessionContextValue {
  me: MeResponse | null;
  // True once a real /api/mobile/me response has been received this
  // session — gates every server-dependent action.
  verified: boolean;
  busy: boolean;
  online: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  pending: number;
  pendingActivityName: string | null;
  // Set whenever a server response's employee id differs from the locally
  // cached one — an admin reassigned this physical device to someone else
  // since the last time it checked in. Holds the *new* MeResponse, not yet
  // applied to `me`/the cached employee summary (see acknowledgeReassignment
  // and ReassignmentOverlay, which is what actually renders this).
  pendingReassignment: MeResponse | null;
  acknowledgeReassignment: () => void;
  loadMe: () => void;
  handleApiError: (err: unknown) => boolean;
  perform: (path: string, body: Record<string, unknown>, options?: PerformOptions) => Promise<void>;
  flush: () => Promise<void>;
  startBreak: () => void;
  endBreak: () => void;
  endDayConfirmOpen: boolean;
  endDaySubmitting: boolean;
  endDayError: string | null;
  openEndDayConfirm: () => void;
  closeEndDayConfirm: () => void;
  confirmEndDay: () => void;
}

const WorkSessionContext = createContext<WorkSessionContextValue | undefined>(undefined);

// Owns everything about "what is the employee's work status and what can
// they do about it right now" — shared between HomeScreen (the activity /
// question-flow UI) and MobileLayout's bottom nav (End Work / Start Break /
// End Break), which needs the same status and actions from every mobile
// screen, not just Home. Mounted once inside MobileLayout, which persists
// across mobile route changes, so switching tabs never interrupts a poll or
// resets status.
export function WorkSessionProvider({ children }: { children: ReactNode }) {
  const { markUnpaired, serverReachable, setServerReachable, refreshCachedEmployee } = useDevicePairing();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(getPendingCount());
  const [pendingActivityName, setPendingActivityName] = useState<string | null>(null);
  const [endDayConfirmOpen, setEndDayConfirmOpen] = useState(false);
  const [endDaySubmitting, setEndDaySubmitting] = useState(false);
  const [endDayError, setEndDayError] = useState<string | null>(null);
  const [endDayIdempotencyKey, setEndDayIdempotencyKey] = useState<string | null>(null);
  const [pendingReassignment, setPendingReassignment] = useState<MeResponse | null>(null);

  // The single place every server response carrying an `employee` gets
  // applied — loadMe, perform, and confirmEndDay all funnel through this
  // rather than each setting me/verified/the cached employee directly, so
  // reassignment can never be missed from one of those call sites just
  // because it was added to another. Compares against the *persisted*
  // cached employee (device.ts), not React state, so this can't miss a
  // reassignment that happened before this tab of WorkSessionProvider ever
  // mounted. When a reassignment is detected, `result` is held in
  // `pendingReassignment` instead of applied — me/verified/the cached
  // employee summary stay exactly as they were until acknowledgeReassignment
  // runs. Deliberately does not touch the offline queue (offlineQueue.ts) in
  // either branch: that queue lives in its own localStorage key untouched by
  // anything here, so legitimate queued offline work survives a pending
  // reassignment exactly as it would survive any other screen transition,
  // and replays normally via flush() once the new employee's session
  // resumes. Returns whether it applied immediately, so a caller with its
  // own post-response cleanup (perform's onResolved, its picker-closing
  // sheets) can skip that cleanup while a reassignment is pending — there's
  // no point closing a sheet for an activity that belonged to whoever used
  // to be paired here.
  const applyMeResponse = useCallback(
    (result: MeResponse): boolean => {
      const cachedEmployeeId = getCachedEmployeeSummary()?.employeeId ?? null;
      if (detectReassignment(cachedEmployeeId, result.employee.id)) {
        setPendingReassignment(result);
        return false;
      }
      setMe(result);
      setVerified(true);
      setServerReachable(true);
      refreshCachedEmployee({
        employeeId: result.employee.id,
        firstName: result.employee.firstName,
        lastName: result.employee.lastName,
        lastVerifiedAt: new Date().toISOString(),
      });
      return true;
    },
    [refreshCachedEmployee, setServerReachable]
  );

  const acknowledgeReassignment = useCallback(() => {
    if (!pendingReassignment) return;
    const result = pendingReassignment;
    setPendingReassignment(null);
    setMe(result);
    setVerified(true);
    setServerReachable(true);
    refreshCachedEmployee({
      employeeId: result.employee.id,
      firstName: result.employee.firstName,
      lastName: result.employee.lastName,
      lastVerifiedAt: new Date().toISOString(),
    });
  }, [pendingReassignment, refreshCachedEmployee, setServerReachable]);

  // The one place every mobile screen decides what a caught error actually
  // means: a confirmed permanent device-auth code clears pairing; a network
  // failure or 5xx means the server just wasn't reached (never touches
  // pairing, never overwrites `me`/the cached employee); anything else is a
  // real, specific rejection the caller should surface. Returns true when
  // the error was fully handled so callers know not to also show a generic
  // error for it.
  const handleApiError = useCallback(
    (err: unknown): boolean => {
      const permanentCode = getPermanentDeviceAuthErrorCode(err);
      if (permanentCode) {
        markUnpaired(permanentCode);
        return true;
      }
      if (isServerUnreachableError(err)) {
        setServerReachable(false);
        return true;
      }
      setServerReachable(true); // a real response came back — the server is up
      return false;
    },
    [markUnpaired, setServerReachable]
  );

  const loadMe = useCallback(() => {
    api<MeResponse>("/api/mobile/me")
      .then((res) => applyMeResponse(res))
      .catch((err) => {
        if (!handleApiError(err)) setError("Could not load status");
      });
  }, [applyMeResponse, handleApiError]);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  // Runs only while the server hasn't been reached — an app left open on
  // screen through a server restart/deploy must reconnect on its own, not
  // only when the tab happens to regain focus or the browser's own
  // online/offline events happen to fire. Stops itself the moment loadMe
  // succeeds and serverReachable flips back.
  useEffect(() => {
    if (serverReachable) return;
    const interval = window.setInterval(loadMe, RECONNECT_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [serverReachable, loadMe]);

  const flush = useCallback(() => {
    // flushQueue's own retry/drop logic only knows "network error" (keep
    // queued) vs "anything else" (drop, report as rejected) — it has no
    // notion of device-auth codes. A queued action replayed after the
    // device was deactivated/unassigned while offline would otherwise just
    // get silently dropped and reported as an ordinary "activity no longer
    // available" rejection, never actually returning the app to Pairing.
    // This flag, set from inside the send wrapper, is how that specific
    // case still gets caught once the whole queue has drained.
    let permanentFailureCode: string | null = null;
    return flushQueue((path, body) =>
      api(path, { method: "POST", body: JSON.stringify(body) }).catch((err) => {
        const code = getPermanentDeviceAuthErrorCode(err);
        if (code) permanentFailureCode = code;
        throw err;
      })
    )
      .then(({ rejected }) => {
        setPending(getPendingCount());
        if (permanentFailureCode) {
          markUnpaired(permanentFailureCode);
          return;
        }
        if (rejected.length > 0) {
          setError(
            "One or more queued activity changes could not be completed because the activity is no longer available. Your status has been refreshed — please choose again."
          );
        }
        if (getPendingCount() === 0) {
          setPendingActivityName(null);
        }
        loadMe();
      })
      .catch(() => {});
  }, [loadMe, markUnpaired]);

  useEffect(() => {
    function goOnline() {
      setOnline(true);
      flush();
    }
    function goOffline() {
      setOnline(false);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    if (navigator.onLine) flush();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flush]);

  const perform = useCallback(
    async (path: string, body: Record<string, unknown>, options?: PerformOptions) => {
      setBusy(true);
      setError(null);
      try {
        const result = await api<MeResponse>(path, { method: "POST", body: JSON.stringify(body) });
        if (applyMeResponse(result)) {
          setPendingActivityName(null);
          options?.onResolved?.();
        }
      } catch (err) {
        const permanentCode = getPermanentDeviceAuthErrorCode(err);
        if (permanentCode) {
          markUnpaired(permanentCode);
          return;
        }
        if (isNetworkError(err)) {
          enqueue({ id: body.idempotencyKey as string, path, body });
          setPending(getPendingCount());
          setServerReachable(false);
          // Visible-but-honest: no timer starts locally for this — it only
          // starts once a real server startedAt comes back after a
          // successful flush. This just tells the employee what's queued.
          if (options?.pendingLabel) setPendingActivityName(options.pendingLabel);
          options?.onResolved?.();
        } else if (err instanceof ApiError && err.status >= 500) {
          setServerReachable(false);
        } else {
          setServerReachable(true);
          setError(err instanceof ApiError ? err.message : "Something went wrong");
        }
      } finally {
        setBusy(false);
      }
    },
    [applyMeResponse, markUnpaired, setServerReachable]
  );

  const startBreak = useCallback(() => {
    perform("/api/mobile/time-entries/break/start", { idempotencyKey: uuid() });
  }, [perform]);

  const endBreak = useCallback(() => {
    perform("/api/mobile/time-entries/break/end", { idempotencyKey: uuid() });
  }, [perform]);

  const openEndDayConfirm = useCallback(() => {
    setEndDayError(null);
    setEndDayIdempotencyKey(uuid());
    setEndDayConfirmOpen(true);
  }, []);

  const closeEndDayConfirm = useCallback(() => {
    if (endDaySubmitting) return; // block dismissal while a request is in flight
    setEndDayConfirmOpen(false);
    setEndDayError(null);
  }, [endDaySubmitting]);

  // Deliberately bypasses perform(): ending the day must never be silently
  // queued for later (per requirement — it's the one action that should
  // require a live connection), whereas perform()'s network-error branch
  // exists specifically to queue everything else for offline replay.
  const confirmEndDay = useCallback(async () => {
    if (!online) {
      setEndDayError("You must be online to finish work.");
      return;
    }
    if (!endDayIdempotencyKey) return;

    setEndDaySubmitting(true);
    setEndDayError(null);
    // TEMPORARY — End Work ~1min delay investigation. Elapsed-time-only, no
    // secrets. Remove once the slow hop is identified.
    const __t0 = performance.now();
    console.log("[timing] confirmEndDay: tapped, request starting");
    try {
      const result = await api<MeResponse>("/api/mobile/time-entries/end-day", {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: endDayIdempotencyKey }),
      });
      console.log(`[timing] confirmEndDay: api() resolved at ${Math.round(performance.now() - __t0)}ms, updating UI state`);
      applyMeResponse(result);
      setEndDayConfirmOpen(false);
      console.log(`[timing] confirmEndDay: UI state updated at ${Math.round(performance.now() - __t0)}ms`);
    } catch (err) {
      const permanentCode = getPermanentDeviceAuthErrorCode(err);
      if (permanentCode) {
        markUnpaired(permanentCode);
        return;
      }
      // Stay open, reusing the same idempotency key on retry — if the first
      // attempt actually succeeded server-side but the response was lost, a
      // retry with the same key returns that same result instead of ending
      // the day twice.
      if (isServerUnreachableError(err)) {
        setServerReachable(false);
        setEndDayError("Could not reach the server. Please try again.");
      } else {
        setEndDayError(err instanceof ApiError ? err.message : "Could not finish work. Please try again.");
      }
    } finally {
      setEndDaySubmitting(false);
    }
  }, [online, endDayIdempotencyKey, applyMeResponse, markUnpaired, setServerReachable]);

  return (
    <WorkSessionContext.Provider
      value={{
        me,
        verified,
        busy,
        online,
        error,
        setError,
        pending,
        pendingActivityName,
        pendingReassignment,
        acknowledgeReassignment,
        loadMe,
        handleApiError,
        perform,
        flush,
        startBreak,
        endBreak,
        endDayConfirmOpen,
        endDaySubmitting,
        endDayError,
        openEndDayConfirm,
        closeEndDayConfirm,
        confirmEndDay,
      }}
    >
      {children}
    </WorkSessionContext.Provider>
  );
}

export function useWorkSession(): WorkSessionContextValue {
  const ctx = useContext(WorkSessionContext);
  if (!ctx) throw new Error("useWorkSession must be used within WorkSessionProvider");
  return ctx;
}
