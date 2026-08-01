import { useCallback, useEffect, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { api, ApiError } from "../../lib/api";
import { enqueue, flushQueue, getPendingCount, isNetworkError } from "../../lib/offlineQueue";
import { uuid } from "../../lib/uuid";
import { ActivityPicker, NO_ACTIVITIES_MESSAGE, PickerActivity } from "../../components/mobile/ActivityPicker";
import { ActivityTimer, formatElapsed } from "../../components/mobile/ActivityTimer";
import { RecentJobsCard, RecentJob } from "../../components/mobile/RecentJobsCard";
import { ConfirmEndDayModal } from "../../components/mobile/ConfirmEndDayModal";

type Activity = PickerActivity;

interface CurrentActivity {
  id: string;
  name: string;
  startedAt: string;
  // Seconds accumulated across earlier segments of the same continuous job
  // chain (same activity, separated only by breaks) before this entry —
  // the live elapsed time since startedAt is added on top by ActivityTimer.
  accumulatedWorkedSecondsBeforeCurrentEntry: number;
}

interface PreviousActivity {
  id: string;
  name: string;
  // Running total for the whole chain up through the segment that just
  // closed when this break started — not just that one segment's length.
  accumulatedWorkedSeconds: number;
}

interface MeResponse {
  employee: { id: string; firstName: string; lastName: string };
  status: "idle" | "work" | "break";
  currentActivity: CurrentActivity | null;
  since: string | null;
  previousActivity: PreviousActivity | null;
  recentJobs: RecentJob[];
}

export function HomeScreen() {
  const { markUnpaired } = useDevicePairing();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activitiesLoaded, setActivitiesLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(getPendingCount());
  const [pendingActivityName, setPendingActivityName] = useState<string | null>(null);
  const [endDayConfirmOpen, setEndDayConfirmOpen] = useState(false);
  const [endDaySubmitting, setEndDaySubmitting] = useState(false);
  const [endDayError, setEndDayError] = useState<string | null>(null);
  const [endDayIdempotencyKey, setEndDayIdempotencyKey] = useState<string | null>(null);

  const handleAuthFailure = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        markUnpaired();
        return true;
      }
      return false;
    },
    [markUnpaired]
  );

  const loadMe = useCallback(() => {
    api<MeResponse>("/api/mobile/me")
      .then(setMe)
      .catch((err) => {
        if (!handleAuthFailure(err)) setError("Could not load status");
      });
  }, [handleAuthFailure]);

  // Always hits the live server endpoint — the phone never has its own
  // notion of which activities exist. Re-run on mount, when connectivity
  // returns, when the tab/app comes back to the foreground, and right
  // before opening the picker so the choice offered is as fresh as
  // possible. Deliberately event-driven rather than polling on a timer.
  const loadActivities = useCallback(() => {
    api<{ activities: Activity[]; activityGroups: { id: string; name: string }[] }>(
      "/api/mobile/activities"
    )
      .then((res) => {
        setActivities(res.activities);
        setActivitiesLoaded(true);
      })
      .catch((err) => {
        handleAuthFailure(err);
      });
  }, [handleAuthFailure]);

  useEffect(() => {
    loadMe();
    loadActivities();
  }, [loadMe, loadActivities]);

  const flush = useCallback(() => {
    flushQueue((path, body) => api(path, { method: "POST", body: JSON.stringify(body) }))
      .then(({ rejected }) => {
        setPending(getPendingCount());
        if (rejected.length > 0) {
          setError(
            "One or more queued activity changes could not be completed because the activity is no longer available. Your status has been refreshed — please choose again."
          );
        }
        if (getPendingCount() === 0) {
          setPendingActivityName(null);
        }
        loadMe();
        loadActivities();
      })
      .catch(() => {});
  }, [loadMe, loadActivities]);

  useEffect(() => {
    function goOnline() {
      setOnline(true);
      flush();
    }
    function goOffline() {
      setOnline(false);
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        loadMe();
        loadActivities();
      }
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (navigator.onLine) flush();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [flush, loadMe, loadActivities]);

  async function perform(path: string, body: Record<string, unknown>, pendingLabel?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<MeResponse>(path, { method: "POST", body: JSON.stringify(body) });
      setMe(result);
      setPendingActivityName(null);
      setPickerOpen(false);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      if (isNetworkError(err)) {
        enqueue({ id: body.idempotencyKey as string, path, body });
        setPending(getPendingCount());
        // Visible-but-honest: no timer starts locally for this — it only
        // starts once a real server startedAt comes back after a
        // successful flush. This just tells the employee what's queued.
        if (pendingLabel) setPendingActivityName(pendingLabel);
        setPickerOpen(false);
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong");
      }
    } finally {
      setBusy(false);
    }
  }

  function openPicker() {
    loadActivities();
    setPickerOpen(true);
  }

  function chooseActivity(activityId: string) {
    const activity = activities.find((a) => a.id === activityId);
    perform("/api/mobile/time-entries/work", { activityId, idempotencyKey: uuid() }, activity?.name);
  }

  function startBreak() {
    perform("/api/mobile/time-entries/break/start", { idempotencyKey: uuid() });
  }

  function endBreak() {
    perform("/api/mobile/time-entries/break/end", { idempotencyKey: uuid() });
  }

  function openEndDayConfirm() {
    setEndDayError(null);
    setEndDayIdempotencyKey(uuid());
    setEndDayConfirmOpen(true);
  }

  function closeEndDayConfirm() {
    if (endDaySubmitting) return; // block dismissal while a request is in flight
    setEndDayConfirmOpen(false);
    setEndDayError(null);
  }

  // Deliberately bypasses perform(): ending the day must never be silently
  // queued for later (per requirement — it's the one action that should
  // require a live connection), whereas perform()'s network-error branch
  // exists specifically to queue everything else for offline replay.
  async function confirmEndDay() {
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
      setEndDayConfirmOpen(false);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      // Stay open, reusing the same idempotency key on retry — if the
      // first attempt actually succeeded server-side but the response was
      // lost, a retry with the same key returns that same result instead
      // of ending the day twice.
      setEndDayError(err instanceof ApiError ? err.message : "Could not finish work. Please try again.");
    } finally {
      setEndDaySubmitting(false);
    }
  }

  if (!me) {
    return (
      <div className="mobile-home">
        <p>Loading...</p>
      </div>
    );
  }

  const noActivitiesAvailable = activitiesLoaded && activities.length === 0;

  return (
    <div className="mobile-home mobile-home-active">
      {/* 1. Employee name + connection status */}
      <div className="mobile-home-header">
        <span className={`connection-dot ${online ? "online" : "offline"}`} />
        <h1>
          {me.employee.firstName} {me.employee.lastName}
        </h1>
      </div>

      {/* 2. Current state */}
      <div className="work-status">
        {me.status === "idle" && <p>Not working</p>}
        {me.status === "work" && <p>Working</p>}
        {me.status === "break" && <p>On break</p>}
      </div>

      {error && !pickerOpen && !endDayConfirmOpen && <p className="error-text">{error}</p>}

      {/* 3. Primary activity button */}
      {me.status === "idle" && (
        <button
          type="button"
          className="mobile-primary-activity"
          disabled={busy || noActivitiesAvailable}
          onClick={openPicker}
        >
          Choose a job
        </button>
      )}
      {me.status === "work" && me.currentActivity && (
        <button type="button" className="mobile-primary-activity" disabled={busy} onClick={openPicker}>
          {me.currentActivity.name}
        </button>
      )}
      {me.status === "break" && (
        <div className="mobile-primary-activity mobile-primary-activity-static">
          {me.previousActivity?.name ?? "On break"}
        </div>
      )}

      {noActivitiesAvailable && me.status === "idle" && <p className="error-text">{NO_ACTIVITIES_MESSAGE}</p>}

      {/* 4. Activity timer */}
      {me.status === "work" && me.currentActivity && (
        <ActivityTimer
          startedAt={me.currentActivity.startedAt}
          offsetSeconds={me.currentActivity.accumulatedWorkedSecondsBeforeCurrentEntry}
          className="mobile-timer"
        />
      )}
      {me.status === "break" && me.since && <ActivityTimer startedAt={me.since} className="mobile-timer" />}
      {me.status === "break" && me.previousActivity && (
        <p className="mobile-timer-static">
          Worked on {me.previousActivity.name} for {formatElapsed(me.previousActivity.accumulatedWorkedSeconds)}{" "}
          before this break
        </p>
      )}

      {/* 5. Break button */}
      {me.status === "work" && (
        <button className="mobile-action-button" disabled={busy} onClick={startBreak}>
          Start Break
        </button>
      )}
      {me.status === "break" && (
        <button className="mobile-action-button mobile-action-primary" disabled={busy} onClick={endBreak}>
          End Break
        </button>
      )}

      {/* 6. End Day */}
      {me.status !== "idle" && (
        <button className="mobile-action-button mobile-action-danger" disabled={busy} onClick={openEndDayConfirm}>
          End Day
        </button>
      )}

      {/* 7. Recent jobs */}
      <RecentJobsCard jobs={me.recentJobs} />

      {/* 8. Sync/offline status */}
      <div className="connection-bar">
        <span className={`connection-dot ${online ? "online" : "offline"}`} />
        {online ? "Online" : "Offline"}
        {pending > 0 && <span className="pending-badge">{pending} pending sync</span>}
      </div>
      {pendingActivityName && (
        <p className="mobile-pending-banner">Switching to {pendingActivityName} — will sync when back online</p>
      )}

      {pickerOpen && (
        <ActivityPicker
          activities={activities}
          currentActivityId={me.status === "work" ? me.currentActivity?.id ?? null : null}
          onSelect={chooseActivity}
          onClose={() => setPickerOpen(false)}
          busy={busy}
          error={error}
        />
      )}

      {endDayConfirmOpen && (
        <ConfirmEndDayModal
          submitting={endDaySubmitting}
          error={endDayError}
          onConfirm={confirmEndDay}
          onCancel={closeEndDayConfirm}
        />
      )}
    </div>
  );
}
