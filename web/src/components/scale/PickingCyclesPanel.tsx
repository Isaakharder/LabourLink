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
  // Superseded cycles (075) waiting for an administrator's review.
  const [toReview, setToReview] = useState<BinCycle[]>([]);
  const [confirming, setConfirming] = useState<{ cycle: BinCycle; requestId: string } | null>(null);

  const load = useCallback(() => {
    api<{ trackingStartedAt: string | null; trackingEverStarted?: boolean; cycles: BinCycle[] }>(`/api/bin-cycles?state=open`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the picking cycles"));
    api<{ cycles: BinCycle[] }>(`/api/bin-cycles?state=review`)
      .then((d) => setToReview((d?.cycles ?? []).filter((c) => c.status === "superseded")))
      .catch(() => setToReview([]));
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

  async function submitConfirm(e: FormEvent) {
    e.preventDefault();
    if (!confirming || saving || reason.trim().length < 3) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bin-cycles/${confirming.cycle.id}/confirm-superseded`, {
        method: "POST",
        body: JSON.stringify({ requestId: confirming.requestId, reason: reason.trim() }),
      });
      setConfirming(null);
      setReason("");
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not confirm this cycle");
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
      {toReview.length > 0 && (
        <>
          <h2>Superseded cycles to review ({toReview.length})</h2>
          <p className="field-hint">
            Another employee started using these bins before they were weighed, so the latest cycle got the credit. To credit one of these
            instead, open the bin's weighing above and choose "Credit this cycle instead".
          </p>
          <div className="scale-weighings-table-wrap">
            <table className="employees-table scale-weighings-table">
              <thead>
                <tr>
                  <th>Bin</th>
                  <th>Employee</th>
                  <th>Started</th>
                  <th>Superseded</th>
                  <th>Why</th>
                  <th>Weighed?</th>
                  {isAdmin && <th />}
                </tr>
              </thead>
              <tbody>
                {toReview.map((c) => (
                  <tr key={c.id}>
                    <td>{c.bin.name}</td>
                    <td>{c.employee.name}</td>
                    <td>{when(c.openedAt)}</td>
                    <td>{c.closedAt ? when(c.closedAt) : ""}</td>
                    <td>{c.lateScan ? "Late conflict: scan arrived after the credit" : "Bin reused before weighing"}</td>
                    <td>{c.settled ? "Yes" : "Not yet"}</td>
                    {isAdmin && (
                      <td>
                        <button type="button" onClick={() => { setConfirming({ cycle: c, requestId: uuid() }); setReason(""); }}>
                          Confirm superseded
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {confirming && (
        <form className="scale-weighing-void" onSubmit={submitConfirm}>
          <p>
            Confirm that {confirming.cycle.employee.name}'s cycle on {confirming.cycle.bin.name} really was superseded (the bin was emptied and
            reused). Nobody's credit changes.
          </p>
          <label>
            Reason (required)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
          </label>
          <div className="modal-actions">
            <button type="button" onClick={() => setConfirming(null)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" disabled={saving || reason.trim().length < 3}>
              {saving ? "Saving..." : "Confirm"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
