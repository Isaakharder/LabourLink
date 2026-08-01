import { useCallback, useEffect, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { api, ApiError } from "../../lib/api";
import { enqueue, flushQueue, getPendingCount, isNetworkError } from "../../lib/offlineQueue";
import { uuid } from "../../lib/uuid";

interface Activity {
  id: string;
  name: string;
}

interface ActivityGroup {
  id: string;
  name: string;
}

interface MeResponse {
  employee: { id: string; firstName: string; lastName: string };
  status: "idle" | "work" | "break";
  activity: Activity | null;
  since: string | null;
}

// Same message whether the employee has no active group at all or their
// group currently has zero active activities — both are "nothing to pick
// from," and the app never falls back to showing all activities either way.
const NO_ACTIVITIES_MESSAGE = "No activities have been assigned to you. Please contact your supervisor.";

export function HomeScreen() {
  const { markUnpaired } = useDevicePairing();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activitiesLoaded, setActivitiesLoaded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(getPendingCount());

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
  // returns, when the tab/app comes back to the foreground (covers a
  // supervisor having changed the employee's group or an activity while the
  // phone was asleep/backgrounded), and right before opening the picker so
  // the choice offered is as fresh as possible. Deliberately event-driven
  // rather than polling on a timer, to avoid unnecessary battery/data use.
  const loadActivities = useCallback(() => {
    api<{ activities: Activity[]; activityGroup: ActivityGroup | null }>("/api/mobile/activities")
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

  async function perform(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<MeResponse>(path, { method: "POST", body: JSON.stringify(body) });
      setMe(result);
      setPicking(false);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      if (isNetworkError(err)) {
        enqueue({ id: body.idempotencyKey as string, path, body });
        setPending(getPendingCount());
        setPicking(false);
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong");
      }
    } finally {
      setBusy(false);
    }
  }

  function openPicker() {
    loadActivities();
    setPicking(true);
  }

  function chooseActivity(activityId: string) {
    perform("/api/mobile/time-entries/work", { activityId, idempotencyKey: uuid() });
  }

  function startBreak() {
    perform("/api/mobile/time-entries/break/start", { idempotencyKey: uuid() });
  }

  function endBreak() {
    perform("/api/mobile/time-entries/break/end", { idempotencyKey: uuid() });
  }

  function endDay() {
    perform("/api/mobile/time-entries/end-day", { idempotencyKey: uuid() });
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
      <div className="connection-bar">
        <span className={`connection-dot ${online ? "online" : "offline"}`} />
        {online ? "Online" : "Offline"}
        {pending > 0 && <span className="pending-badge">{pending} pending sync</span>}
      </div>

      <h1>
        {me.employee.firstName} {me.employee.lastName}
      </h1>

      <div className="work-status">
        {me.status === "idle" && <p>Not working</p>}
        {me.status === "work" && (
          <p>
            Working: <strong>{me.activity?.name}</strong>
          </p>
        )}
        {me.status === "break" && <p>On break</p>}
      </div>

      {error && <p className="error-text">{error}</p>}

      {noActivitiesAvailable && !picking && <p className="error-text">{NO_ACTIVITIES_MESSAGE}</p>}

      {picking ? (
        <div className="activity-picker">
          {activities.length === 0 ? (
            <p>{NO_ACTIVITIES_MESSAGE}</p>
          ) : (
            <>
              <p>Choose an activity:</p>
              {activities.map((a) => (
                <button
                  key={a.id}
                  className="mobile-action-button mobile-action-primary"
                  disabled={busy}
                  onClick={() => chooseActivity(a.id)}
                >
                  {a.name}
                </button>
              ))}
            </>
          )}
          <button
            className="mobile-action-button mobile-action-secondary"
            disabled={busy}
            onClick={() => setPicking(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="mobile-actions">
          {me.status === "idle" && (
            <button
              className="mobile-action-button mobile-action-primary"
              disabled={busy || noActivitiesAvailable}
              onClick={openPicker}
            >
              Start Work
            </button>
          )}
          {me.status === "work" && (
            <>
              <button
                className="mobile-action-button"
                disabled={busy || noActivitiesAvailable}
                onClick={openPicker}
              >
                Change Activity
              </button>
              <button className="mobile-action-button" disabled={busy} onClick={startBreak}>
                Start Break
              </button>
            </>
          )}
          {me.status === "break" && (
            <button
              className="mobile-action-button mobile-action-primary"
              disabled={busy}
              onClick={endBreak}
            >
              End Break
            </button>
          )}
          {me.status !== "idle" && (
            <button
              className="mobile-action-button mobile-action-danger"
              disabled={busy}
              onClick={endDay}
            >
              End Day
            </button>
          )}
        </div>
      )}
    </div>
  );
}
