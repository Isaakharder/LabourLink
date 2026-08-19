import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkSession } from "../../context/WorkSessionContext";
import { getLocalEventStore, LocalEvent } from "../../lib/localEventStore";
import { getOrCreateDeviceIdentifier } from "../../lib/device";
import { computeSyncIndicatorState } from "../../lib/syncIndicator";

const EVENT_TYPE_LABELS: Record<string, string> = {
  work_start: "Start work",
  activity_switch: "Switch activity",
  break_start: "Start break",
  break_end: "End break",
  end_day: "Finish work",
};

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface ConflictedEventView {
  clientEventId: string;
  eventType: string;
  occurredAtUtc: string;
  reason: string | null;
}

function parseConflictReason(event: LocalEvent): string | null {
  if (!event.serverResultJson) return null;
  try {
    const parsed = JSON.parse(event.serverResultJson) as { detail?: { reason?: string } };
    return parsed.detail?.reason ?? null;
  } catch {
    return null;
  }
}

// Reachable from Settings > Sync > "Sync details" — the diagnostic detail
// screen the plan calls for: pending count, last sync times, conflicted
// events with their diagnostic ids, a retry button. Deliberately NO discard/
// clear-unsynced-work action anywhere on this screen — a pending event only
// ever leaves the queue by actually syncing (or, for a genuine conflict, by
// an administrator resolving it server-side on the desktop Sync Conflicts
// page, which this screen doesn't attempt to duplicate).
export function SyncStatusScreen() {
  const { online, pending, syncProblem, flush } = useWorkSession();
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<string | null>(null);
  const [lastAttemptedSyncAt, setLastAttemptedSyncAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictedEventView[]>([]);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    const deviceId = getOrCreateDeviceIdentifier();
    const store = getLocalEventStore();
    const [summary, conflictedEvents] = await Promise.all([store.getSyncSummary(deviceId), store.getConflictedEvents(deviceId)]);
    setLastSuccessfulSyncAt(summary.lastSuccessfulSyncAt);
    setLastAttemptedSyncAt(summary.lastAttemptedSyncAt);
    setLastError(summary.lastError);
    setConflicts(
      conflictedEvents.map((event) => ({
        clientEventId: event.clientEventId,
        eventType: event.eventType,
        occurredAtUtc: event.occurredAtUtc,
        reason: parseConflictReason(event),
      }))
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load, pending]);

  async function handleRetry() {
    setRetrying(true);
    await flush();
    await load();
    setRetrying(false);
  }

  const syncState = computeSyncIndicatorState({ online, pending, syncProblem });
  const stateLabel =
    syncState === "synced"
      ? "Synced"
      : syncState === "pending"
        ? `${pending} pending`
        : syncState === "offline"
          ? pending > 0
            ? `Offline — ${pending} pending`
            : "Offline"
          : "Sync problem";

  return (
    <div className="mobile-settings">
      <h1>Sync Details</h1>
      <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
        Back to Settings
      </Link>

      <section className="mobile-settings-device-section">
        <h2>Status</h2>
        <div className="sync-status">
          <span className={`connection-dot ${syncState === "synced" || syncState === "pending" ? "" : "offline"}`} />
          {stateLabel}
        </div>
        <p className="mobile-settings-device-note">Pending events: {pending}</p>
        <p className="mobile-settings-device-note">Last successful sync: {formatDateTime(lastSuccessfulSyncAt)}</p>
        <p className="mobile-settings-device-note">Last attempted sync: {formatDateTime(lastAttemptedSyncAt)}</p>
        {lastError && <p className="error-text">Last error: {lastError}</p>}
        <button
          type="button"
          className="mobile-action-button mobile-action-primary"
          onClick={handleRetry}
          disabled={retrying || pending === 0}
        >
          {retrying ? "Retrying..." : "Retry now"}
        </button>
      </section>

      <section className="mobile-settings-device-section">
        <h2>Conflicts ({conflicts.length})</h2>
        {conflicts.length === 0 ? (
          <p className="mobile-settings-device-note">
            No conflicts. A conflict means the server could not apply one of this device's events automatically (e.g.
            an activity or row that no longer exists) — it stays here, unresolved, until an administrator reviews it.
            There is no action to take on this device; nothing here is discarded.
          </p>
        ) : (
          <ul className="mobile-settings-device-note" style={{ listStyle: "none", padding: 0 }}>
            {conflicts.map((c) => (
              <li key={c.clientEventId} style={{ marginBottom: "12px" }}>
                <strong>{EVENT_TYPE_LABELS[c.eventType] ?? c.eventType}</strong> at{" "}
                {new Date(c.occurredAtUtc).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
                <br />
                {c.reason && <span>Reason: {c.reason}</span>}
                <br />
                <span title={c.clientEventId}>Diagnostic ID: {c.clientEventId.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
