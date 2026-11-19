import { FormEvent, useCallback, useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { api, ApiError } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { BIN_CYCLE_STATUS_LABELS, BinCycle } from "../../lib/scaleWeighingTypes";
import { formatDateLongInAppTimezone, formatTimeInAppTimezone } from "../../lib/timezone";

const when = (iso: string) => `${formatDateLongInAppTimezone(iso)} ${formatTimeInAppTimezone(iso, { seconds: false })}`;

// Open bin picking cycles (server/src/routes/binCycles.ts): which bins are
// being filled or are waiting to be weighed, and by whom. A bin emptied
// without being weighed keeps its cycle open; an Administrator closes it here
// so the bin's next scan starts a clean cycle. Closing never credits anyone.
export function PickingCyclesPanel({ onChanged }: { onChanged: () => void }) {
  const { employee } = useAuth();
  const isAdmin = employee?.securityRole === "Administrator";
  const [data, setData] = useState<{ trackingStartedAt: string | null; trackingEverStarted?: boolean; cycles: BinCycle[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ cycle: BinCycle; requestId: string } | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<{ trackingStartedAt: string | null; trackingEverStarted?: boolean; cycles: BinCycle[] }>(`/api/bin-cycles?state=open`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the picking cycles"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function submitClose(e: FormEvent) {
    e.preventDefault();
    if (!closing || saving || reason.trim().length < 3) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bin-cycles/${closing.cycle.id}/close`, { method: "POST", body: JSON.stringify({ requestId: closing.requestId, reason: reason.trim() }) });
      setClosing(null);
      setReason("");
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not close this picking cycle");
    } finally {
      setSaving(false);
    }
  }

  // Greenhouses without LabourLink Scale (tracking never started) never see this.
  if (data && !data.trackingStartedAt && !data.trackingEverStarted) return null;
  return (
    <section className="setup-section scale-weighings picking-cycles">
      <h2>Open picking cycles</h2>
      <p className="field-hint">
        A cycle starts when an employee chooses a bin on their phone and ends when the bin is weighed. A bin weighed again without a new phone
        scan is not credited.
      </p>
      {data && !data.trackingStartedAt && <p className="field-hint">Picking-cycle tracking is stopped. Weighings use the previous matching rule.</p>}
      {error && <p className="error-text">{error}</p>}
      {!data ? (
        !error && <p>Loading...</p>
      ) : data.cycles.length === 0 ? (
        <p className="placeholder-page">No open picking cycles.</p>
      ) : (
        <div className="scale-weighings-table-wrap">
          <table className="employees-table scale-weighings-table">
            <thead>
              <tr>
                <th>Bin</th>
                <th>Status</th>
                <th>Employee</th>
                <th>Started</th>
                <th>Last scan</th>
                <th className="num">Scans</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {data.cycles.map((c) => (
                <tr key={c.id}>
                  <td>{c.bin.name}</td>
                  <td>
                    {BIN_CYCLE_STATUS_LABELS[c.status]}
                    {c.status === "awaiting_weighing" && c.awaitingSince && <div className="field-hint">since {when(c.awaitingSince)}</div>}
                    {c.reviewReason && <div className="field-hint">{c.reviewReason}</div>}
                  </td>
                  <td>{c.employee.name}</td>
                  <td>{when(c.openedAt)}</td>
                  <td>{when(c.lastScanAt)}</td>
                  <td className="num">{c.scanCount}</td>
                  {isAdmin && (
                    <td>
                      <button type="button" className="scale-void-button" onClick={() => { setClosing({ cycle: c, requestId: uuid() }); setReason(""); }}>
                        Close without weighing
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {closing && (
        <form className="scale-weighing-void" onSubmit={submitClose}>
          <p>
            Close {closing.cycle.bin.name}'s cycle (started by {closing.cycle.employee.name}) without weighing? Nobody is credited for it, and the
            bin's next phone scan starts a new cycle.
          </p>
          <label>
            Reason (required)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
          </label>
          <div className="modal-actions">
            <button type="button" onClick={() => setClosing(null)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="danger" disabled={saving || reason.trim().length < 3}>
              {saving ? "Closing..." : "Close cycle"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
