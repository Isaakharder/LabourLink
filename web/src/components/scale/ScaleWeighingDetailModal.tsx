import { FormEvent, useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { useAuth } from "../../context/AuthContext";
import { api, ApiError } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { ScaleWeighingDetail, STATUS_LABELS, ScaleWeighingStatus } from "../../lib/scaleWeighingTypes";
import { formatDateLongInAppTimezone, formatTimeInAppTimezone } from "../../lib/timezone";
import { StatusBadge } from "./StatusBadge";

const when = (iso: string) => `${formatDateLongInAppTimezone(iso)} ${formatTimeInAppTimezone(iso)}`;
const kg = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} kg`;
const statusLabel = (s: string | null) => (s ? (STATUS_LABELS[s as ScaleWeighingStatus] ?? s) : "—");

const EVENT_LABELS: Record<string, string> = {
  received: "Received from the station",
  status: "Assignment",
  late_conflict: "Late claim by another employee (credit unchanged)",
  void: "Credit voided",
};

// One weighing: weights, who it was credited to and why, the phone claims
// behind it, and every change since it arrived. Administrators can void an
// incorrect credit here; nothing about the weighing itself is changed or
// deleted.
export function ScaleWeighingDetailModal({ weighingId, onClose, onChanged }: { weighingId: string; onClose: () => void; onChanged: () => void }) {
  const { employee } = useAuth();
  const [w, setW] = useState<ScaleWeighingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  // One id per open dialog: a double click or a retry is applied once.
  const correctionId = useMemo(() => uuid(), []);

  useEffect(() => {
    api<{ weighing: ScaleWeighingDetail }>(`/api/scale-weighings/${weighingId}`)
      .then((r) => setW(r.weighing))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load this weighing"));
  }, [weighingId]);

  async function submitVoid(e: FormEvent) {
    e.preventDefault();
    if (saving || reason.trim().length < 3) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ weighing: ScaleWeighingDetail }>(`/api/scale-weighings/${weighingId}/void`, {
        method: "POST",
        body: JSON.stringify({ correctionId, reason: reason.trim() }),
      });
      setW(r.weighing);
      setVoiding(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not void this credit");
    } finally {
      setSaving(false);
    }
  }

  const canVoid = employee?.securityRole === "Administrator" && w?.status === "credited";

  return (
    <Modal title={w ? `${w.bin.name} · ${formatTimeInAppTimezone(w.weighedAt, { seconds: false })}` : "Weighing"} onClose={onClose} wide>
      {error && <p className="error-text">{error}</p>}
      {!w ? (
        !error && <p>Loading...</p>
      ) : (
        <div className="scale-weighing-detail">
          <dl className="scale-weighing-facts">
            <dt>Status</dt>
            <dd>
              <StatusBadge row={w} />
              {w.matchReason && <div className="field-hint">{w.matchReason}</div>}
              {w.pendingUntil && <div className="field-hint">Waiting for a phone bin choice until {when(w.pendingUntil)}</div>}
            </dd>
            <dt>Employee</dt>
            <dd>{w.employee?.name ?? "—"}</dd>
            <dt>Weighed</dt>
            <dd>{when(w.weighedAt)}</dd>
            <dt>Bin</dt>
            <dd>
              {w.bin.name} · tag {w.rfidTag}
            </dd>
            <dt>Weights</dt>
            <dd>
              {kg(w.grossKg)} gross − {kg(w.tareKg)} tare = <strong>{kg(w.netKg)} net</strong>
            </dd>
            <dt>Station</dt>
            <dd>
              {w.stationName} · received {when(w.receivedAt)}
            </dd>
            <dt>Counts toward</dt>
            <dd>
              {w.countsForProduction ? "Production totals" : "Not counted in production totals"}
              {" · "}
              {w.countsAsCredit ? "the employee's credits" : "no employee credit"}
            </dd>
          </dl>

          {w.claims.length > 0 && (
            <>
              <h3>Phone bin choices behind the credit</h3>
              <ul className="scale-weighing-list">
                {w.claims.map((c, i) => (
                  <li key={i}>
                    {c.employeeName} chose this bin at {when(c.occurredAt)}
                    {c.deviceName ? ` on ${c.deviceName}` : ""} <span className="field-hint">(synced {when(c.receivedAt)})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {w.flags.length > 0 && (
            <>
              <h3>Other employees who chose this bin</h3>
              <ul className="scale-weighing-list">
                {w.flags.map((f, i) => (
                  <li key={i}>
                    {f.employeeName} at {when(f.occurredAt)} <span className="field-hint">({f.kind === "late_conflict" ? "after the credit; credit unchanged" : "same bin use"})</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>History</h3>
          <ul className="scale-weighing-list">
            {w.history.map((h, i) => (
              <li key={i}>
                <strong>{EVENT_LABELS[h.kind] ?? h.kind}</strong>
                {h.toStatus && h.kind !== "received" ? `: ${statusLabel(h.fromStatus)} → ${statusLabel(h.toStatus)}` : ""}
                {h.employeeName ? ` · ${h.employeeName}` : ""}
                {h.actorName ? ` · by ${h.actorName}` : ""}
                <div className="field-hint">
                  {when(h.at)}
                  {h.reason ? ` · ${h.reason}` : ""}
                </div>
              </li>
            ))}
          </ul>

          {w.corrections.length > 0 && (
            <>
              <h3>Corrections</h3>
              <ul className="scale-weighing-list">
                {w.corrections.map((c, i) => (
                  <li key={i}>
                    Credit to {c.previousEmployeeName ?? "—"} voided by {c.performedBy}
                    <div className="field-hint">
                      {when(c.performedAt)} · {c.reason}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {w.samplesKg.length > 0 && (
            <details className="scale-weighing-samples">
              <summary>Stable readings ({w.samplesKg.length})</summary>
              <p>{w.samplesKg.map((s) => s.toFixed(1)).join(", ")} kg</p>
            </details>
          )}

          {canVoid && !voiding && (
            <div className="employee-form-actions">
              <button type="button" className="scale-void-button" onClick={() => setVoiding(true)}>
                Void this credit
              </button>
            </div>
          )}
          {canVoid && voiding && (
            <form className="scale-weighing-void" onSubmit={submitVoid}>
              <p>
                The credit to <strong>{w.employee?.name}</strong> for {kg(w.netKg)} will stop counting in every total. The weighing, its weights
                and who it was credited to stay on record. This can't be undone.
              </p>
              <label>
                Reason (required)
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
              </label>
              <div className="employee-form-actions">
                <button type="button" onClick={() => setVoiding(false)} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="scale-void-button" disabled={saving || reason.trim().length < 3}>
                  {saving ? "Voiding..." : "Void credit"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </Modal>
  );
}
