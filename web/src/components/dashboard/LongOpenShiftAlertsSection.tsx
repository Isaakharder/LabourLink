import { useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";

export interface LongOpenShiftAlert {
  employeeId: string;
  employeeName: string;
  entryType: "work" | "break";
  activityName: string | null;
  shiftStartedAt: string;
  openHours: number;
}

interface GetLongOpenShiftAlertsResponse {
  thresholdHours: number;
  timezone: string;
  alerts: LongOpenShiftAlert[];
}

// "3h 42m" style — matches ActivityTimer's own rounding-to-the-minute
// convention elsewhere in the app rather than a raw decimal-hours number.
function formatDuration(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatDateTime(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Value for a <input type="datetime-local"> defaulted to "now" — must be
// the LOCAL wall-clock reading (not toISOString(), which is UTC and would
// silently shift the default by the timezone offset), truncated to the
// minute the input control itself works in.
function nowForDateTimeInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface EndWorkModalProps {
  alert: LongOpenShiftAlert;
  timezone: string;
  submitting: boolean;
  error: string | null;
  onConfirm: (endedAtIso: string) => void;
  onCancel: () => void;
}

function EndWorkModal({ alert, timezone, submitting, error, onConfirm, onCancel }: EndWorkModalProps) {
  const [proposedLocal, setProposedLocal] = useState(nowForDateTimeInput());

  const statusLabel =
    alert.entryType === "work" ? alert.activityName ?? "Working" : "On break";

  function handleConfirm() {
    if (!proposedLocal) return;
    // datetime-local's value has no timezone of its own — new Date(...)
    // on a "YYYY-MM-DDTHH:mm" string parses it in the BROWSER's local
    // timezone, which is what this input control's own clock face means to
    // the person typing into it (the org-timezone label alongside the
    // field is a clarifying display, not a claim the browser and org
    // timezone differ — see this component's own header comment).
    onConfirm(new Date(proposedLocal).toISOString());
  }

  return (
    <Modal title="End Work" onClose={submitting ? () => {} : onCancel}>
      <div className="long-shift-end-work-form">
        <dl className="long-shift-end-work-summary">
          <dt>Employee</dt>
          <dd>{alert.employeeName}</dd>
          <dt>Current status</dt>
          <dd>{statusLabel}</dd>
          <dt>Continuous shift start</dt>
          <dd>{formatDateTime(alert.shiftStartedAt, timezone)}</dd>
          <dt>Current duration</dt>
          <dd>{formatDuration(alert.openHours)}</dd>
        </dl>

        <label className="long-shift-end-work-time-label">
          Proposed end date/time ({timezone})
          <input
            type="datetime-local"
            value={proposedLocal}
            onChange={(e) => setProposedLocal(e.target.value)}
            disabled={submitting}
            required
          />
        </label>
        <p className="long-shift-end-work-hint">
          Defaults to now — enter the employee's actual finish time if it was earlier.
        </p>

        {error && <p className="error-text">{error}</p>}

        <div className="employee-form-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="employee-form-save" onClick={handleConfirm} disabled={submitting || !proposedLocal}>
            {submitting ? "Ending..." : "Confirm End Work"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface LongOpenShiftAlertCardProps {
  alert: LongOpenShiftAlert;
  timezone: string;
  onEndWork: () => void;
}

function LongOpenShiftAlertCard({ alert, timezone, onEndWork }: LongOpenShiftAlertCardProps) {
  return (
    <div className="long-shift-alert-card">
      <div className="long-shift-alert-body">
        <p className="long-shift-alert-headline">
          {alert.employeeName} has been {alert.entryType === "work" ? "working" : "on break"} for {formatDuration(alert.openHours)}
        </p>
        <p className="long-shift-alert-detail">
          {alert.entryType === "work" && alert.activityName ? `${alert.activityName} · ` : ""}
          Continuous since {formatDateTime(alert.shiftStartedAt, timezone)}
        </p>
      </div>
      <div className="long-shift-alert-actions">
        <button type="button" onClick={onEndWork}>
          End Work
        </button>
      </div>
    </div>
  );
}

// Near the top of the Dashboard (alongside WorkPermitAlertsSection), per
// the requirements: a workday that's remained open (continuously, across
// any midnight-rollover boundaries) longer than the configurable org
// threshold. Restricted server-side (GET /api/dashboard/long-open-shift-
// alerts, POST .../end-work both requireRole("Administrator","Manager")) —
// this component simply doesn't render for anyone else, same "silently
// nothing rather than an error banner" convention as WorkPermitAlertsSection.
interface LongOpenShiftAlertsSectionProps {
  // Fired after a successful End Work — lets DashboardPage refresh its own
  // card grid too (the ended employee may have been showing as an active
  // card), not just this section's own alert list.
  onEnded?: () => void;
}

export function LongOpenShiftAlertsSection({ onEnded }: LongOpenShiftAlertsSectionProps = {}) {
  const [alerts, setAlerts] = useState<LongOpenShiftAlert[] | null>(null);
  const [timezone, setTimezone] = useState("UTC");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<LongOpenShiftAlert | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<GetLongOpenShiftAlertsResponse>("/api/dashboard/long-open-shift-alerts")
      .then((res) => {
        setAlerts(res.alerts);
        setTimezone(res.timezone);
        setLoadError(null);
      })
      .catch((err) => {
        // A 403 just means this viewer isn't Administrator/Manager — render
        // nothing rather than an error banner every other role would see on
        // every Dashboard visit.
        if (err instanceof ApiError && err.status === 403) {
          setAlerts([]);
          return;
        }
        setLoadError(err instanceof ApiError ? err.message : "Could not load long-open-shift alerts");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleConfirm(endedAtIso: string) {
    if (!target) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await api(`/api/dashboard/long-open-shift-alerts/${target.employeeId}/end-work`, {
        method: "POST",
        body: JSON.stringify({ endedAt: endedAtIso }),
      });
      setTarget(null);
      // Removes the alert immediately and picks up any newly-crossed
      // threshold elsewhere, rather than just splicing this one card out
      // client-side.
      load();
      onEnded?.();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not end this employee's work");
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!alerts || alerts.length === 0) return null;

  return (
    <section className="long-shift-alerts-section">
      <h2>Long Open Shifts</h2>
      <div className="long-shift-alerts-list">
        {alerts.map((alert) => (
          <LongOpenShiftAlertCard key={alert.employeeId} alert={alert} timezone={timezone} onEndWork={() => setTarget(alert)} />
        ))}
      </div>

      {target && (
        <EndWorkModal
          alert={target}
          timezone={timezone}
          submitting={submitting}
          error={actionError}
          onConfirm={handleConfirm}
          onCancel={() => {
            setTarget(null);
            setActionError(null);
          }}
        />
      )}
    </section>
  );
}
