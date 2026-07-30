import { useCallback, useEffect, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { api, ApiError } from "../../lib/api";
import { enqueue, flushQueue, getPendingCount, isNetworkError } from "../../lib/offlineQueue";
import { uuid } from "../../lib/uuid";

interface Activity {
  id: string;
  name: string;
}

interface MeResponse {
  employee: { id: string; firstName: string; lastName: string };
  status: "idle" | "work" | "break";
  activity: Activity | null;
  since: string | null;
}

export function HomeScreen() {
  const { markUnpaired } = useDevicePairing();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
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

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  useEffect(() => {
    api<{ activities: Activity[] }>("/api/mobile/activities")
      .then((res) => setActivities(res.activities))
      .catch(() => {});
  }, []);

  const flush = useCallback(() => {
    flushQueue((path, body) => api(path, { method: "POST", body: JSON.stringify(body) }))
      .then(() => {
        setPending(getPendingCount());
        loadMe();
      })
      .catch(() => {});
  }, [loadMe]);

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
  }, [flush]);

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

      {picking ? (
        <div className="activity-picker">
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
              disabled={busy}
              onClick={() => setPicking(true)}
            >
              Start Work
            </button>
          )}
          {me.status === "work" && (
            <>
              <button className="mobile-action-button" disabled={busy} onClick={() => setPicking(true)}>
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
