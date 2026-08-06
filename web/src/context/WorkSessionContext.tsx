import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useDevicePairing } from "./DevicePairingContext";
import { api, ApiError, isPermanentDeviceAuthError, isServerUnreachableError } from "../lib/api";
import { enqueue, flushQueue, getPendingCount, isNetworkError } from "../lib/offlineQueue";
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
  loadMe: () => void;
  handleApiError: (err: unknown) => boolean;
  perform: (path: string, body: Record<string, unknown>, options?: PerformOptions) => Promise<void>;
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

  // The one place every mobile screen decides what a caught error actually
  // means: a confirmed permanent device-auth code clears pairing; a network
  // failure or 5xx means the server just wasn't reached (never touches
  // pairing, never overwrites `me`/the cached employee); anything else is a
  // real, specific rejection the caller should surface. Returns true when
  // the error was fully handled so callers know not to also show a generic
  // error for it.
  const handleApiError = useCallback(
    (err: unknown): boolean => {
      if (isPermanentDeviceAuthError(err)) {
        markUnpaired();
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
      .then((res) => {
        setMe(res);
        setVerified(true);
        setServerReachable(true);
        refreshCachedEmployee({
          employeeId: res.employee.id,
          firstName: res.employee.firstName,
          lastName: res.employee.lastName,
          lastVerifiedAt: new Date().toISOString(),
        });
      })
      .catch((err) => {
        if (!handleApiError(err)) setError("Could not load status");
      });
  }, [handleApiError, refreshCachedEmployee, setServerReachable]);

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
    let permanentFailure = false;
    flushQueue((path, body) =>
      api(path, { method: "POST", body: JSON.stringify(body) }).catch((err) => {
        if (isPermanentDeviceAuthError(err)) permanentFailure = true;
        throw err;
      })
    )
      .then(({ rejected }) => {
        setPending(getPendingCount());
        if (permanentFailure) {
          markUnpaired();
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
        setMe(result);
        setVerified(true);
        setServerReachable(true);
        refreshCachedEmployee({
          employeeId: result.employee.id,
          firstName: result.employee.firstName,
          lastName: result.employee.lastName,
          lastVerifiedAt: new Date().toISOString(),
        });
        setPendingActivityName(null);
        options?.onResolved?.();
      } catch (err) {
        if (isPermanentDeviceAuthError(err)) {
          markUnpaired();
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
    [markUnpaired, refreshCachedEmployee, setServerReachable]
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
    try {
      const result = await api<MeResponse>("/api/mobile/time-entries/end-day", {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: endDayIdempotencyKey }),
      });
      setMe(result);
      setVerified(true);
      setServerReachable(true);
      setEndDayConfirmOpen(false);
    } catch (err) {
      if (isPermanentDeviceAuthError(err)) {
        markUnpaired();
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
  }, [online, endDayIdempotencyKey, markUnpaired, setServerReachable]);

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
        loadMe,
        handleApiError,
        perform,
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
