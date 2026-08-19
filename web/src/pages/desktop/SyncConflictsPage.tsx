import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/layout/PageHeader";
import { api, ApiError } from "../../lib/api";
import { formatDateLong, formatTimeInAppTimezone } from "../../lib/timezone";

interface SyncConflict {
  id: string;
  clientEventId: string;
  deviceName: string | null;
  employeeName: string | null;
  deviceSeq: number;
  eventType: string;
  occurredAtUtc: string;
  receivedAt: string;
  // "accepted" only ever appears here when it also carries a
  // conflict_reason — the server never returns an ordinary, non-anomalous
  // accepted row from this endpoint (see mobileSyncConflicts.ts's
  // REVIEWABLE_CONDITION), so any "accepted" row in this list specifically
  // means a device-clock anomaly was flagged on an event that still
  // applied normally (see mobileTime.ts's detectClockAnomaly).
  processingStatus: "permanent_conflict" | "sequence_gap" | "accepted";
  conflictReason: string | null;
  conflictDetail: unknown;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  work_start: "Start work",
  activity_switch: "Switch activity",
  break_start: "Start break",
  break_end: "End break",
  end_day: "Finish work",
};

const STATUS_LABELS: Record<string, string> = {
  permanent_conflict: "Conflict",
  sequence_gap: "Sequence gap",
  accepted: "Clock anomaly",
};

// A device/employee's own offline event that the sync ledger (server/src/
// routes/mobileTime.ts's POST /sync/events) either could not apply as-is —
// an invalid/deleted activity or row, no prior activity to resume, events
// arriving permanently out of order — or DID apply but the device's own
// clock looked wrong when it did (see detectClockAnomaly). Never
// auto-resolved and never silently dropped (see that route's own
// comments): this page is where an administrator actually sees these and,
// after taking whatever real correction is needed elsewhere (a manual
// Inputs correction), marks one reviewed. "Resolve" here never itself
// touches time_entries.
export function SyncConflictsPage() {
  const [conflicts, setConflicts] = useState<SyncConflict[] | null>(null);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ conflicts: SyncConflict[] }>(`/api/mobile-sync/conflicts?includeResolved=${includeResolved}`)
      .then((res) => {
        setConflicts(res.conflicts);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load sync conflicts"));
  }, [includeResolved]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleResolve(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/mobile-sync/conflicts/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ note: noteDrafts[id]?.trim() || undefined }),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not mark this conflict reviewed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleUnresolve(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/mobile-sync/conflicts/${id}/unresolve`, { method: "POST" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not undo that");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Sync conflicts"
        description="Offline mobile events that could not be applied automatically, or that applied with a suspect device clock — reviewed here, never auto-resolved."
      />
      <section className="setup-section">
        <label className="field-hint" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
          Show already-reviewed conflicts too
        </label>

        {error && <p className="error-text">{error}</p>}

        {!conflicts ? (
          <p>Loading...</p>
        ) : conflicts.length === 0 ? (
          <p className="placeholder-page">
            {includeResolved ? "No sync conflicts have ever been recorded." : "No unresolved sync conflicts — nothing needs review."}
          </p>
        ) : (
          <table className="employees-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Employee</th>
                <th>Device</th>
                <th>Action</th>
                <th>Occurred</th>
                <th>Reason</th>
                <th>Diagnostic ID</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c) => (
                <tr key={c.id}>
                  <td>{STATUS_LABELS[c.processingStatus] ?? c.processingStatus}</td>
                  <td>{c.employeeName ?? "—"}</td>
                  <td>{c.deviceName ?? "—"}</td>
                  <td>{EVENT_TYPE_LABELS[c.eventType] ?? c.eventType}</td>
                  <td>
                    {formatDateLong(c.occurredAtUtc)} {formatTimeInAppTimezone(c.occurredAtUtc)}
                  </td>
                  <td>{c.conflictReason ?? "—"}</td>
                  <td title={c.clientEventId}>{c.clientEventId.slice(0, 8)}</td>
                  <td>
                    {c.resolvedAt ? (
                      <div>
                        <p className="field-hint">
                          Reviewed by {c.resolvedBy ?? "—"}
                          {c.resolutionNote ? `: ${c.resolutionNote}` : ""}
                        </p>
                        <button type="button" disabled={busyId === c.id} onClick={() => handleUnresolve(c.id)}>
                          Undo
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <input
                          type="text"
                          placeholder="Optional note (what was done about it)"
                          value={noteDrafts[c.id] ?? ""}
                          onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        />
                        <button
                          type="button"
                          className="employees-add-button"
                          disabled={busyId === c.id}
                          onClick={() => handleResolve(c.id)}
                        >
                          Mark reviewed
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
