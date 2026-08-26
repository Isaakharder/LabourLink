import { FormEvent, useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Avatar } from "../employees/Avatar";
import { api, ApiError } from "../../lib/api";
import { formatRemainingTime, formatWorkPermitDate, formatWorkPermitLead, WorkPermitAlert } from "../../lib/workPermitTypes";

// Rounded, human headline duration ("6 months" / "45 days") — distinct
// from formatRemainingTime's exact "X months, Y days" body text (used
// elsewhere on the card), matching the brief's own example headline
// ("Work permit expiring in 6 months") which is a round approximation, not
// an exact day count.
function formatHeadlineDuration(remainingDays: number): string {
  if (remainingDays < 60) return `${remainingDays} day${remainingDays === 1 ? "" : "s"}`;
  const months = Math.round(remainingDays / 30.44);
  return `${months} month${months === 1 ? "" : "s"}`;
}

function severityClass(severity: WorkPermitAlert["severity"]): string {
  return `work-permit-alert-card work-permit-alert-${severity}`;
}

interface RenewModalProps {
  alert: WorkPermitAlert;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (newExpiryDate: string) => void;
}

function RenewModal({ alert, busy, onCancel, onConfirm }: RenewModalProps) {
  const [newExpiryDate, setNewExpiryDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!newExpiryDate) {
      setError("A new expiry date is required");
      return;
    }
    if (newExpiryDate <= alert.expiryDate) {
      setError("The new expiry date must be later than the current expiry date");
      return;
    }
    setError(null);
    onConfirm(newExpiryDate);
  }

  return (
    <Modal title="Renewed" onClose={onCancel}>
      <form onSubmit={handleSubmit} className="work-permit-renew-form">
        <p>
          {alert.employeeName}'s current work permit expires {formatWorkPermitDate(alert.expiryDate)}. Enter the new
          expiry date from the renewed permit.
        </p>
        <label>
          New expiry date *
          <input type="date" value={newExpiryDate} onChange={(e) => setNewExpiryDate(e.target.value)} required disabled={busy} />
        </label>
        {error && <span className="field-error">{error}</span>}
        <div className="employee-form-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="employee-form-save" disabled={busy}>
            {busy ? "Saving..." : "Save renewal"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface CancelAlertModalProps {
  alert: WorkPermitAlert;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string | null) => void;
}

function CancelAlertModal({ alert, busy, onCancel, onConfirm }: CancelAlertModalProps) {
  const [reason, setReason] = useState("");

  return (
    <Modal title="Cancel alert?" onClose={onCancel}>
      <div className="work-permit-cancel-form">
        <p>
          This cancels the alert for {alert.employeeName}'s work permit expiring {formatWorkPermitDate(alert.expiryDate)}. It
          won't show again unless the expiry date changes.
        </p>
        <label>
          Reason (optional)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} disabled={busy} />
        </label>
        <div className="employee-form-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Never mind
          </button>
          <button type="button" className="employee-form-save" onClick={() => onConfirm(reason.trim() || null)} disabled={busy}>
            {busy ? "Cancelling..." : "Cancel alert"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface WorkPermitAlertCardProps {
  alert: WorkPermitAlert;
  busy: boolean;
  onAcknowledge: () => void;
  onRenew: () => void;
  onCancel: () => void;
}

function WorkPermitAlertCard({ alert, busy, onAcknowledge, onRenew, onCancel }: WorkPermitAlertCardProps) {
  const isExpired = alert.severity === "expired";
  const headline = isExpired
    ? alert.remainingDays === -1
      ? "Work permit expired"
      : `Work permit overdue by ${Math.abs(alert.remainingDays)} days`
    : `Work permit expiring in ${formatHeadlineDuration(alert.remainingDays)}`;

  return (
    <div className={severityClass(alert.severity)}>
      <Avatar photoUrl={alert.photoUrl} firstName={alert.employeeName.split(" ")[0] ?? ""} lastName={alert.employeeName.split(" ").slice(1).join(" ")} />
      <div className="work-permit-alert-body">
        <p className="work-permit-alert-headline">{headline}</p>
        <p className="work-permit-alert-detail">
          {alert.employeeName}'s work permit {isExpired ? "expired" : "expires"} {formatWorkPermitDate(alert.expiryDate)}.
        </p>
        <p className="work-permit-alert-meta">
          {isExpired ? (
            <>Expired · {formatRemainingTime(Math.abs(alert.remainingDays))} ago</>
          ) : (
            <>{formatRemainingTime(alert.remainingDays)} remaining</>
          )}
          {" · notify lead "}
          {formatWorkPermitLead(alert.leadMonths, alert.leadDays)}
        </p>
      </div>
      <div className="work-permit-alert-actions">
        <button type="button" onClick={onAcknowledge} disabled={busy}>
          {busy ? "..." : "Acknowledge"}
        </button>
        <button type="button" onClick={onRenew} disabled={busy}>
          Renewed
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel alert
        </button>
      </div>
    </div>
  );
}

// Near the top of the Dashboard, per the brief — but entirely absent (not
// an empty shell) whenever there are zero active alerts, and restricted
// server-side (not only by this component simply not rendering) to
// Administrator/Manager, since GET /api/dashboard/work-permit-alerts
// itself 403s for any other role.
export function WorkPermitAlertsSection() {
  const [alerts, setAlerts] = useState<WorkPermitAlert[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [renewTarget, setRenewTarget] = useState<WorkPermitAlert | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WorkPermitAlert | null>(null);

  const load = useCallback(() => {
    api<{ alerts: WorkPermitAlert[] }>("/api/dashboard/work-permit-alerts")
      .then((res) => {
        setAlerts(res.alerts);
        setLoadError(null);
      })
      .catch((err) => {
        // A 403 here just means this viewer isn't Administrator/Manager —
        // silently render nothing rather than showing an error banner
        // every non-manager sees on every Dashboard visit.
        if (err instanceof ApiError && err.status === 403) {
          setAlerts([]);
          return;
        }
        setLoadError(err instanceof ApiError ? err.message : "Could not load work permit alerts");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAcknowledge(alert: WorkPermitAlert) {
    setProcessingId(alert.employeeId);
    setActionError(null);
    try {
      await api(`/api/employees/${alert.employeeId}/acknowledge`, { method: "POST" });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not acknowledge this alert");
    } finally {
      setProcessingId(null);
    }
  }

  async function handleRenewConfirm(newExpiryDate: string) {
    if (!renewTarget) return;
    setProcessingId(renewTarget.employeeId);
    setActionError(null);
    try {
      await api(`/api/employees/${renewTarget.employeeId}/renew`, { method: "POST", body: JSON.stringify({ newExpiryDate }) });
      setRenewTarget(null);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save this renewal");
    } finally {
      setProcessingId(null);
    }
  }

  async function handleCancelConfirm(reason: string | null) {
    if (!cancelTarget) return;
    setProcessingId(cancelTarget.employeeId);
    setActionError(null);
    try {
      await api(`/api/employees/${cancelTarget.employeeId}/cancel-alert`, { method: "POST", body: JSON.stringify({ reason }) });
      setCancelTarget(null);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not cancel this alert");
    } finally {
      setProcessingId(null);
    }
  }

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!alerts || alerts.length === 0) return null;

  return (
    <section className="work-permit-alerts-section">
      <h2>Work Permit Alerts</h2>
      {actionError && <p className="error-text">{actionError}</p>}
      <div className="work-permit-alerts-list">
        {alerts.map((alert) => (
          <WorkPermitAlertCard
            key={alert.employeeId}
            alert={alert}
            busy={processingId === alert.employeeId}
            onAcknowledge={() => handleAcknowledge(alert)}
            onRenew={() => setRenewTarget(alert)}
            onCancel={() => setCancelTarget(alert)}
          />
        ))}
      </div>

      {renewTarget && (
        <RenewModal
          alert={renewTarget}
          busy={processingId === renewTarget.employeeId}
          onCancel={() => setRenewTarget(null)}
          onConfirm={handleRenewConfirm}
        />
      )}
      {cancelTarget && (
        <CancelAlertModal
          alert={cancelTarget}
          busy={processingId === cancelTarget.employeeId}
          onCancel={() => setCancelTarget(null)}
          onConfirm={handleCancelConfirm}
        />
      )}
    </section>
  );
}
