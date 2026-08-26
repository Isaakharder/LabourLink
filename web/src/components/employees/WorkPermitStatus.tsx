import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Employee } from "../../lib/employeeTypes";
import { formatWorkPermitDate, WorkPermitHistoryEntry } from "../../lib/workPermitTypes";
import { todayInAppTimezone } from "../../lib/timezone";

interface WorkPermitStatusResponse {
  expiryDate: string | null;
  isCancelled: boolean;
  acknowledgedUntil: string | null;
}

interface WorkPermitStatusProps {
  employee: Employee;
}

// Compact permit status on the employee profile — "Valid until…" / "Alert
// acknowledged until…" / "Expired" / a togglable "Renewed / history" list.
// Deliberately separate from the Dashboard's Work Permit Alerts section
// (which only ever lists employees currently inside their notification
// window) — this reflects one employee's full current state regardless of
// whether an active alert exists for them right now.
export function WorkPermitStatus({ employee }: WorkPermitStatusProps) {
  const [status, setStatus] = useState<WorkPermitStatusResponse | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<WorkPermitHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    setStatus(null);
    if (!employee.workPermitExpiryDate) return;
    api<WorkPermitStatusResponse>(`/api/employees/${employee.id}/status`).then(setStatus).catch(() => setStatus(null));
  }, [employee.id, employee.workPermitExpiryDate]);

  async function toggleHistory() {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    if (history) return;
    setHistoryLoading(true);
    try {
      const res = await api<{ history: WorkPermitHistoryEntry[] }>(`/api/employees/${employee.id}/history`);
      setHistory(res.history);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  if (!employee.workPermitExpiryDate) {
    return <span className="work-permit-status-none">Not tracked</span>;
  }

  // Today's calendar date IN THE APP TIMEZONE, compared as plain
  // YYYY-MM-DD strings — same convention the server uses throughout (see
  // workPermits.ts). This is display-only (the server's own GET /status
  // and /work-permit-alerts are authoritative), but should still never
  // show a false "Expired"/"Valid" relative to what the server computes.
  const expired = employee.workPermitExpiryDate < todayInAppTimezone();

  return (
    <div className="work-permit-status">
      <p className={expired ? "work-permit-status-expired" : "work-permit-status-valid"}>
        {expired ? "Expired " : "Valid until "}
        {formatWorkPermitDate(employee.workPermitExpiryDate)}
      </p>
      {status?.acknowledgedUntil && (
        <p className="work-permit-status-acknowledged">
          Alert acknowledged until {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(status.acknowledgedUntil))}
        </p>
      )}
      {status?.isCancelled && <p className="work-permit-status-cancelled">Alert cancelled for this expiry date</p>}
      <button type="button" className="work-permit-history-toggle" onClick={toggleHistory}>
        {historyOpen ? "Hide history" : "Renewed / history"}
      </button>
      {historyOpen && (
        <div className="work-permit-history-list">
          {historyLoading ? (
            <p className="placeholder-page">Loading...</p>
          ) : !history || history.length === 0 ? (
            <p className="placeholder-page">No history yet.</p>
          ) : (
            <ul>
              {history.map((h) => (
                <li key={h.id}>
                  <span>
                    {h.oldExpiryDate ? formatWorkPermitDate(h.oldExpiryDate) : "(none)"} →{" "}
                    {h.newExpiryDate ? formatWorkPermitDate(h.newExpiryDate) : "(cleared)"}
                  </span>
                  <span className="work-permit-history-meta">
                    {h.changedBy}, {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(h.changedAt))}
                    {h.reason ? ` — ${h.reason}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
