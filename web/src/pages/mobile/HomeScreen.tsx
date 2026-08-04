import { useCallback, useEffect, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { api, ApiError, isPermanentDeviceAuthError, isServerUnreachableError } from "../../lib/api";
import { enqueue, flushQueue, getPendingCount, isNetworkError } from "../../lib/offlineQueue";
import { uuid } from "../../lib/uuid";
import { ActivityPicker, NO_ACTIVITIES_MESSAGE, PickerActivity } from "../../components/mobile/ActivityPicker";
import { RowPickerSheet, RowPickerLand } from "../../components/mobile/RowPickerSheet";
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
  row: { id: string; label: string } | null;
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

// While the server hasn't yet been reached this poll cycle, retry this
// often — only runs while serverReachable is false (see the effect below),
// so a healthy app never has a background timer running at all.
const RECONNECT_POLL_INTERVAL_MS = 15000;

export function HomeScreen() {
  const { markUnpaired, cachedEmployee, serverReachable, setServerReachable, refreshCachedEmployee } =
    useDevicePairing();
  const [me, setMe] = useState<MeResponse | null>(null);
  // True once a real /api/mobile/me response has been received this
  // session — gates every server-dependent action button. Before that (the
  // "just launched, still offline" window), the last-known employee name is
  // shown from the pairing context's cache, but nothing that assumes we
  // know the employee's true current status is offered, since we don't
  // actually know it yet.
  const [verified, setVerified] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activitiesLoaded, setActivitiesLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rowLands, setRowLands] = useState<RowPickerLand[] | null>(null);
  const [rowPickerOpen, setRowPickerOpen] = useState(false);
  // The activity a row is being picked for — either a brand-new
  // start/switch (from chooseActivity) or a same-activity "Change Row"
  // (from the current-activity affordance). Only id/name are needed here;
  // RowPickerSheet itself only needs a name to display and reports back a
  // chosen rowId, the caller already knows which activityId it's for.
  const [pendingRowActivity, setPendingRowActivity] = useState<{ id: string; name: string } | null>(null);
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
  // the error was fully handled (pairing cleared or marked unreachable) so
  // callers know not to also show a generic error for it.
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

  // Same event-driven wiring as loadActivities — the phone never has its
  // own notion of which activities exist. Re-run on mount, when connectivity
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
        handleApiError(err);
      });
  }, [handleApiError]);

  // Same event-driven wiring as loadActivities — the phone never has its
  // own notion of which rows exist either.
  const loadGreenhouseRows = useCallback(() => {
    api<{ lands: RowPickerLand[] }>("/api/mobile/greenhouse-rows")
      .then((res) => setRowLands(res.lands))
      .catch((err) => {
        handleApiError(err);
      });
  }, [handleApiError]);

  useEffect(() => {
    loadMe();
    loadActivities();
    loadGreenhouseRows();
  }, [loadMe, loadActivities, loadGreenhouseRows]);

  // Runs only while the server hasn't been reached — an app left open on
  // screen through a server restart/deploy must reconnect on its own, not
  // only when the tab happens to regain focus or the browser's own
  // online/offline events happen to fire (neither necessarily happens for
  // "Wi-Fi was fine the whole time, the API process itself was down").
  // Stops itself the moment loadMe succeeds and serverReachable flips back.
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
        loadActivities();
      })
      .catch(() => {});
  }, [loadMe, loadActivities, markUnpaired]);

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
        loadGreenhouseRows();
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
  }, [flush, loadMe, loadActivities, loadGreenhouseRows]);

  async function perform(path: string, body: Record<string, unknown>, pendingLabel?: string) {
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
      setPickerOpen(false);
      setRowPickerOpen(false);
      setPendingRowActivity(null);
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
        if (pendingLabel) setPendingActivityName(pendingLabel);
        setPickerOpen(false);
        setRowPickerOpen(false);
        setPendingRowActivity(null);
      } else if (err instanceof ApiError && err.status >= 500) {
        setServerReachable(false);
      } else {
        // Stays open (whichever sheet — ActivityPicker or RowPickerSheet —
        // triggered this) so the employee sees the error and can retry
        // without losing their place; both sheets render `error` inline.
        setServerReachable(true);
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
    // Any configured question — required or optional — opens the row
    // picker so its label and Skip/Confirm choice are always shown. Only
    // an activity with no question at all starts immediately.
    if (activity?.question) {
      loadGreenhouseRows();
      setPendingRowActivity({ id: activity.id, name: activity.name });
      setPickerOpen(false);
      setRowPickerOpen(true);
      return;
    }
    perform("/api/mobile/time-entries/work", { activityId, idempotencyKey: uuid() }, activity?.name);
  }

  function confirmRow(rowId: string) {
    if (!pendingRowActivity) return;
    perform(
      "/api/mobile/time-entries/work",
      { activityId: pendingRowActivity.id, greenhouseRowId: rowId, idempotencyKey: uuid() },
      pendingRowActivity.name
    );
  }

  // Only reachable when the pending activity's question is optional (see
  // RowPickerSheet's allowSkip prop) — starts the activity with no row
  // rather than forcing a selection.
  function skipRow() {
    if (!pendingRowActivity) return;
    perform(
      "/api/mobile/time-entries/work",
      { activityId: pendingRowActivity.id, idempotencyKey: uuid() },
      pendingRowActivity.name
    );
  }

  function cancelRowPicker() {
    if (busy) return;
    setRowPickerOpen(false);
    setPendingRowActivity(null);
  }

  // "Change Row" — the only UI path for requirement 8's "same activity,
  // different row." Reuses the exact same perform() call the initial
  // required-question start does, just with the current activity's id
  // instead of a newly-picked one; a fresh idempotencyKey is what makes the
  // server open a new row/close the old one (see openEntry in
  // mobileTime.ts), and accumulateChainSeconds' row-equality check is what
  // makes the timer correctly reset for it.
  function openChangeRow() {
    if (!me?.currentActivity) return;
    loadGreenhouseRows();
    setPendingRowActivity({ id: me.currentActivity.id, name: me.currentActivity.name });
    setRowPickerOpen(true);
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
      setVerified(true);
      setServerReachable(true);
      setEndDayConfirmOpen(false);
    } catch (err) {
      if (isPermanentDeviceAuthError(err)) {
        markUnpaired();
        return;
      }
      // Stay open, reusing the same idempotency key on retry — if the
      // first attempt actually succeeded server-side but the response was
      // lost, a retry with the same key returns that same result instead
      // of ending the day twice.
      if (isServerUnreachableError(err)) {
        setServerReachable(false);
        setEndDayError("Could not reach the server. Please try again.");
      } else {
        setEndDayError(err instanceof ApiError ? err.message : "Could not finish work. Please try again.");
      }
    } finally {
      setEndDaySubmitting(false);
    }
  }

  // Nothing at all yet — never paired on this device before, or paired but
  // no cached employee has ever been written (shouldn't happen once paired,
  // but a first-ever pairing with no connectivity before the first /me
  // response lands here too). A real "Loading..." is the honest state.
  if (!me && !cachedEmployee) {
    return (
      <div className="mobile-home">
        <p>Loading...</p>
      </div>
    );
  }

  // A cached name exists from a previous session, but this session hasn't
  // reached the server yet — show who's paired and that we're reconnecting,
  // but nothing that assumes we know their actual current status (idle?
  // mid-shift? on break?), since we genuinely don't yet. No action buttons
  // at all here rather than guessing which ones would be safe.
  if (!me && cachedEmployee) {
    return (
      <div className="mobile-home">
        <div className="mobile-home-header">
          <span className="connection-dot offline" />
          <h1>
            {cachedEmployee.firstName} {cachedEmployee.lastName}
          </h1>
        </div>
        <div className="mobile-offline-banner">Offline — reconnecting…</div>
        <p className="mobile-cached-note">
          Last confirmed {new Date(cachedEmployee.lastVerifiedAt).toLocaleString()}
        </p>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  const noActivitiesAvailable = activitiesLoaded && activities.length === 0;
  const actionsLocked = !verified || busy;

  return (
    <div className="mobile-home mobile-home-active">
      {/* 1. Employee name + connection status */}
      <div className="mobile-home-header">
        <span className={`connection-dot ${online && serverReachable ? "online" : "offline"}`} />
        <h1>
          {me!.employee.firstName} {me!.employee.lastName}
        </h1>
      </div>

      {!serverReachable && <div className="mobile-offline-banner">Offline — reconnecting…</div>}

      {/* 2. Current state */}
      <div className="work-status">
        {me!.status === "idle" && <p>Not working</p>}
        {me!.status === "work" && <p>Working</p>}
        {me!.status === "break" && <p>On break</p>}
      </div>

      {error && !pickerOpen && !rowPickerOpen && !endDayConfirmOpen && <p className="error-text">{error}</p>}

      {/* 3. Primary activity button */}
      {me!.status === "idle" && (
        <button
          type="button"
          className="mobile-primary-activity"
          disabled={actionsLocked || noActivitiesAvailable}
          onClick={openPicker}
        >
          Choose a job
        </button>
      )}
      {me!.status === "work" && me!.currentActivity && (
        <button type="button" className="mobile-primary-activity" disabled={actionsLocked} onClick={openPicker}>
          {me!.currentActivity.name}
        </button>
      )}
      {me!.status === "work" && me!.currentActivity?.row && (
        <button type="button" className="mobile-change-row" disabled={actionsLocked} onClick={openChangeRow}>
          {me!.currentActivity.row.label} · Change
        </button>
      )}
      {me!.status === "break" && (
        <div className="mobile-primary-activity mobile-primary-activity-static">
          {me!.previousActivity?.name ?? "On break"}
        </div>
      )}

      {noActivitiesAvailable && me!.status === "idle" && <p className="error-text">{NO_ACTIVITIES_MESSAGE}</p>}

      {/* 4. Activity timer */}
      {me!.status === "work" && me!.currentActivity && (
        <ActivityTimer
          startedAt={me!.currentActivity.startedAt}
          offsetSeconds={me!.currentActivity.accumulatedWorkedSecondsBeforeCurrentEntry}
          className="mobile-timer"
        />
      )}
      {me!.status === "break" && me!.since && <ActivityTimer startedAt={me!.since} className="mobile-timer" />}
      {me!.status === "break" && me!.previousActivity && (
        <p className="mobile-timer-static">
          Worked on {me!.previousActivity.name} for {formatElapsed(me!.previousActivity.accumulatedWorkedSeconds)}{" "}
          before this break
        </p>
      )}

      {/* 5. Break button */}
      {me!.status === "work" && (
        <button className="mobile-action-button" disabled={actionsLocked} onClick={startBreak}>
          Start Break
        </button>
      )}
      {me!.status === "break" && (
        <button className="mobile-action-button mobile-action-primary" disabled={actionsLocked} onClick={endBreak}>
          End Break
        </button>
      )}

      {/* 6. End Day */}
      {me!.status !== "idle" && (
        <button className="mobile-action-button mobile-action-danger" disabled={actionsLocked} onClick={openEndDayConfirm}>
          End Day
        </button>
      )}

      {/* 7. Recent jobs */}
      <RecentJobsCard jobs={me!.recentJobs} />

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
          currentActivityId={me!.status === "work" ? me!.currentActivity?.id ?? null : null}
          onSelect={chooseActivity}
          onClose={() => setPickerOpen(false)}
          busy={busy}
          error={error}
        />
      )}

      {rowPickerOpen && pendingRowActivity && (
        <RowPickerSheet
          activityName={pendingRowActivity.name}
          questionLabel={activities.find((a) => a.id === pendingRowActivity.id)?.question?.label ?? "Where?"}
          allowSkip={activities.find((a) => a.id === pendingRowActivity.id)?.question?.isRequired === false}
          lands={rowLands}
          error={error}
          busy={busy}
          onConfirm={confirmRow}
          onSkip={skipRow}
          onCancel={cancelRowPicker}
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
