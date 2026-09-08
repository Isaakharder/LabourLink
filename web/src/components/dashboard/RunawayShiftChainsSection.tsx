import { useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";

export interface PendingRunawayChain {
  employeeId: string;
  employeeName: string;
  terminalEntryId: string;
  genuineAnchorAt: string;
  safetyCutoffAt: string;
  hoursSinceAnchor: number;
}

function formatDuration(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Same "LOCAL wall-clock reading, not toISOString()" convention as
// LongOpenShiftAlertsSection's own EndWorkModal.
function nowForDateTimeInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface ConfirmEndWorkModalProps {
  chain: PendingRunawayChain;
  submitting: boolean;
  error: string | null;
  onConfirm: (endedAtIso: string) => void;
  onCancel: () => void;
}

// Deliberately its own modal, not a reuse of LongOpenShiftAlertsSection's
// EndWorkModal — the entry here is already CLOSED (at an assumed, unverified
// time), not open, so "continuous shift start / current duration" wording
// would misdescribe what's actually being confirmed. Both ultimately call
// the exact same server action (POST .../end-work → endLongOpenShift), which
// already knows how to correct an already-safety-cutoff-closed entry instead
// of requiring an open one — see longShiftAdminEnd.ts.
function ConfirmEndWorkModal({ chain, submitting, error, onConfirm, onCancel }: ConfirmEndWorkModalProps) {
  const [proposedLocal, setProposedLocal] = useState(nowForDateTimeInput());

  function handleConfirm() {
    if (!proposedLocal) return;
    onConfirm(new Date(proposedLocal).toISOString());
  }

  return (
    <Modal title="Confirm real end time" onClose={submitting ? () => {} : onCancel}>
      <div className="long-shift-end-work-form">
        <dl className="long-shift-end-work-summary">
          <dt>Employee</dt>
          <dd>{chain.employeeName}</dd>
          <dt>Last genuine activity</dt>
          <dd>{formatDateTime(chain.genuineAnchorAt)}</dd>
          <dt>Automatically stopped at</dt>
          <dd>{formatDateTime(chain.safetyCutoffAt)} (assumed, not confirmed)</dd>
          <dt>Time since last genuine activity</dt>
          <dd>{formatDuration(chain.hoursSinceAnchor)}</dd>
        </dl>

        <label className="long-shift-end-work-time-label">
          Actual end date/time
          <input
            type="datetime-local"
            value={proposedLocal}
            onChange={(e) => setProposedLocal(e.target.value)}
            disabled={submitting}
            required
          />
        </label>
        <p className="long-shift-end-work-hint">
          Replaces the automatically-assumed end time above with the employee's real finish time.
        </p>

        {error && <p className="error-text">{error}</p>}

        <div className="employee-form-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="employee-form-save" onClick={handleConfirm} disabled={submitting || !proposedLocal}>
            {submitting ? "Saving..." : "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface RunawayShiftChainCardProps {
  chain: PendingRunawayChain;
  onConfirmEnd: () => void;
}

function RunawayShiftChainCard({ chain, onConfirmEnd }: RunawayShiftChainCardProps) {
  return (
    <div className="long-shift-alert-card inputs-safety-cutoff-review">
      <div className="long-shift-alert-body">
        <p className="long-shift-alert-headline">
          <span className="inputs-needs-review-badge">Needs review</span>
          {chain.employeeName}'s shift was automatically stopped
        </p>
        <p className="long-shift-alert-detail">
          No genuine activity for {formatDuration(chain.hoursSinceAnchor)} — last seen {formatDateTime(chain.genuineAnchorAt)}, auto-stopped{" "}
          {formatDateTime(chain.safetyCutoffAt)}
        </p>
      </div>
      <div className="long-shift-alert-actions">
        <button type="button" onClick={onConfirmEnd}>
          Confirm real end time
        </button>
      </div>
    </div>
  );
}

// The runaway-shift safety cutoff (server/src/lib/runawayShiftAutoCutoff.ts)
// closes an abandoned shift chain automatically once it's gone too long with
// no genuine employee/device or administrator action — but the time it
// closes at is only an assumption, never administrator-confirmed. Unlike
// LongOpenShiftAlertsSection (which lists still-OPEN shifts), the entries
// here are already closed, so they'd otherwise vanish from view with no
// prompt for an admin to go supply the real end time. Same Administrator/
// Manager-only server-side gating; renders nothing for anyone else.
interface RunawayShiftChainsSectionProps {
  onResolved?: () => void;
}

export function RunawayShiftChainsSection({ onResolved }: RunawayShiftChainsSectionProps = {}) {
  const [chains, setChains] = useState<PendingRunawayChain[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<PendingRunawayChain | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ chains: PendingRunawayChain[] }>("/api/dashboard/runaway-shift-chains")
      .then((res) => {
        setChains(res.chains);
        setLoadError(null);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setChains([]);
          return;
        }
        setLoadError(err instanceof ApiError ? err.message : "Could not load runaway shift chains");
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
      // Same endpoint Long Open Shift Alerts uses — endLongOpenShift already
      // detects there's no OPEN entry here and instead corrects the entry
      // its own safety_cutoff_at marks as pending review.
      await api(`/api/dashboard/long-open-shift-alerts/${target.employeeId}/end-work`, {
        method: "POST",
        body: JSON.stringify({ endedAt: endedAtIso }),
      });
      setTarget(null);
      load();
      onResolved?.();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not confirm this employee's real end time");
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!chains || chains.length === 0) return null;

  return (
    <section className="long-shift-alerts-section">
      <h2>Automatically Stopped Shifts</h2>
      <div className="long-shift-alerts-list">
        {chains.map((chain) => (
          <RunawayShiftChainCard key={chain.employeeId} chain={chain} onConfirmEnd={() => setTarget(chain)} />
        ))}
      </div>

      {target && (
        <ConfirmEndWorkModal
          chain={target}
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
