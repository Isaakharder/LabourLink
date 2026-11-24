import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { ALLOCATION_STATUS_BADGE, ALLOCATION_STATUS_LABELS, AllocationDetail, AllocationHistoryEntry } from "../../lib/scaleProductivityAllocationTypes";
import { APP_TIMEZONE, formatDateLongInAppTimezone, formatTimeInAppTimezone } from "../../lib/timezone";

const when = (iso: string) => `${formatDateLongInAppTimezone(iso)} ${formatTimeInAppTimezone(iso, { seconds: false })}`;
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: APP_TIMEZONE, month: "short", day: "numeric" });
const span = (a: string, b: string) => `${shortDay(a)} ${formatTimeInAppTimezone(a, { seconds: false })}–${shortDay(a) === shortDay(b) ? "" : shortDay(b) + " "}${formatTimeInAppTimezone(b, { seconds: false })}`;
const kg = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 3 });
const ACTION_LABELS: Record<AllocationHistoryEntry["action"], string> = {
  confirm: "Confirmed the proposed allocation",
  override: "Corrected the allocation",
  exclude: "Excluded the bin from kg/hour",
  reset: "Reset to the automatic rules",
};

type Mode = "confirm" | "override" | "exclude" | "reset";

// One weighed bin's kg/hour allocation (Administrator only): every employee
// who picked into it since its previous weighing, their matched minutes, the
// calculated share and what counts now, with confirm / correct / exclude /
// reset and the full history. Productivity reporting only: the official
// scale credit is shown but never changed.
export function AllocationReviewModal({ weighingId, activityId, onClose, onChanged }: { weighingId: string; activityId: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<AllocationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(uuid);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [byHand, setByHand] = useState(false);
  const [kgInput, setKgInput] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // The breakdown scrolls sideways on narrow screens while correcting; start
  // from its left edge whenever the form opens or closes.
  const tableWrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tableWrap.current) tableWrap.current.scrollLeft = 0;
  }, [mode, byHand]);

  const load = useCallback(() => {
    api<AllocationDetail>(`/api/scale-productivity-allocations/${weighingId}?activityId=${encodeURIComponent(activityId)}`)
      .then((x) => {
        setD(x);
        setError(null);
        setStale(false);
        const pickers = x.contributors.filter((c) => c.matchedSeconds > 0);
        const fromDecision = new Map((x.decision?.shares ?? []).map((s) => [s.employeeId, s]));
        setIncluded(Object.fromEntries(pickers.map((c) => [c.employeeId, fromDecision.get(c.employeeId)?.included ?? true])));
        setKgInput(Object.fromEntries(pickers.map((c) => [c.employeeId, String(fromDecision.get(c.employeeId)?.allocatedKg ?? c.proposedKg)])));
        setByHand(x.decision?.method === "manual");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load this allocation"));
  }, [weighingId, activityId]);
  useEffect(() => {
    load();
  }, [load]);

  const pickers = d?.contributors.filter((c) => c.matchedSeconds > 0) ?? [];
  const handSum = pickers.filter((c) => included[c.employeeId]).reduce((s, c) => s + Math.round((Number(kgInput[c.employeeId]) || 0) * 1000), 0);
  const netG = d ? Math.round(d.netKg * 1000) : 0;
  // What a counted figure is: the measured net weight (one employee gets the
  // whole bin), an estimate from picking minutes, or set by an administrator.
  const countedPeople = d?.contributors.filter((c) => c.counted).length ?? 0;
  const countedLabel = d?.status === "manual" ? "set by an administrator" : countedPeople === 1 ? "whole bin (measured)" : "estimated from minutes";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!d || !mode || saving || reason.trim().length < 3) return;
    if (mode === "override" && byHand && handSum !== netG) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/scale-productivity-allocations/${weighingId}/decision`, {
        method: "POST",
        body: JSON.stringify({
          requestId,
          activityId,
          action: mode,
          reason: reason.trim(),
          expectedVersion: d.version,
          expectedFingerprint: d.fingerprint,
          ...(mode === "override"
            ? {
                shares: pickers.map((c) => ({
                  employeeId: c.employeeId,
                  included: !!included[c.employeeId],
                  allocatedKg: byHand && included[c.employeeId] ? Number(kgInput[c.employeeId]) || 0 : null,
                })),
              }
            : {}),
        }),
      });
      setMode(null);
      setReason("");
      setRequestId(uuid());
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this decision");
      if (err instanceof ApiError && err.status === 409) setStale(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={d ? `${d.bin} · ${formatTimeInAppTimezone(d.weighedAt, { seconds: false })} · kg/hour allocation` : "kg/hour allocation"} onClose={onClose} xxl>
      {error && (
        <p className="error-text" role="alert">
          {error}{" "}
          {stale && (
            <button type="button" className="scale-button scale-button-quiet" onClick={load}>
              Reload
            </button>
          )}
        </p>
      )}
      {!d ? (
        !error && <p>Loading...</p>
      ) : (
        <div className="scale-weighing-detail">
          <dl className="scale-weighing-facts">
            <dt>Allocation</dt>
            <dd>
              <span className={`scale-status scale-status-${ALLOCATION_STATUS_BADGE[d.status]}`}>{ALLOCATION_STATUS_LABELS[d.status]}</span>
              {d.reasons.map((r) => (
                <div key={r.code} className="field-hint">
                  {r.label}
                </div>
              ))}
            </dd>
            <dt>Net weight</dt>
            <dd>
              <strong>{kg(d.netKg)} kg</strong> ({kg(d.grossKg)} gross − {kg(d.tareKg)} tare)
            </dd>
            <dt>Weighed</dt>
            <dd>{when(d.weighedAt)}</dd>
            {d.loadStart && (
              <>
                <dt>Load since</dt>
                <dd>
                  {when(d.loadStart)}
                  <div className="field-hint">The bin's previous weighing (or the start of picking-cycle tracking). Everything picked into it since counts here.</div>
                </dd>
              </>
            )}
            <dt>Official credit</dt>
            <dd>
              {d.officialCredit?.name ?? "—"}
              <div className="field-hint">The scale credit. Not changed by this allocation, which is for kg/hour only.</div>
            </dd>
          </dl>

          {!d.allocatable ? (
            <p className="field-hint">No picking time matches this bin for this job, so there is nothing to allocate.</p>
          ) : (
            <>
              <h3>Employees who picked into this bin</h3>
              <div className="scale-weighings-table-wrap allocation-table-wrap" ref={tableWrap}>
                <table className="employees-table scale-weighings-table allocation-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th className="num">Minutes</th>
                      <th className="num">Share</th>
                      <th className="num">Calculated kg</th>
                      <th className="num">Counted kg</th>
                      {mode === "override" && <th>Include</th>}
                      {mode === "override" && byHand && <th className="num">Set kg</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {d.contributors.map((c) => (
                      <tr key={c.employeeId}>
                        <td>
                          {c.name}
                          {c.matchedSeconds === 0 && <div className="field-hint">Scanned the bin, no picking time (gets nothing)</div>}
                          {c.otherJobMinutes > 0 && <div className="field-hint">{c.otherJobMinutes} min with this bin under another job</div>}
                          {c.firstAt && c.lastAt && <div className="field-hint">{span(c.firstAt, c.lastAt)}</div>}
                        </td>
                        <td className="num">{c.matchedMinutes.toFixed(1)}</td>
                        <td className="num">{c.matchedSeconds > 0 ? `${c.percent.toFixed(2)}%` : "—"}</td>
                        <td className="num">
                          {c.matchedSeconds > 0 ? (
                            <>
                              {kg(c.proposedKg)}
                              <div className="field-hint">estimated</div>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="num">
                          {c.countedKg != null && c.counted ? (
                            <>
                              {kg(c.countedKg)}
                              <div className="field-hint">{countedLabel}</div>
                            </>
                          ) : (
                            <span className="field-hint">not counted</span>
                          )}
                        </td>
                        {mode === "override" && (
                          <td>
                            {c.matchedSeconds > 0 && (
                              <input
                                type="checkbox"
                                aria-label={`Include ${c.name}`}
                                checked={!!included[c.employeeId]}
                                onChange={(e) => setIncluded((x) => ({ ...x, [c.employeeId]: e.target.checked }))}
                              />
                            )}
                          </td>
                        )}
                        {mode === "override" && byHand && (
                          <td className="num">
                            {c.matchedSeconds > 0 && included[c.employeeId] && (
                              <input
                                className="allocation-kg-input"
                                type="number"
                                step="0.001"
                                min="0"
                                inputMode="decimal"
                                aria-label={`Kilograms for ${c.name}`}
                                value={kgInput[c.employeeId] ?? ""}
                                onChange={(e) => setKgInput((x) => ({ ...x, [c.employeeId]: e.target.value }))}
                              />
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="field-hint">
                Net weight is measured by the scale. Calculated kilograms are an estimate from picking minutes; kilograms set by an administrator are
                labelled as such.
              </p>

              {d.decision && (
                <p className="field-hint">
                  {ACTION_LABELS[d.decision.action]} by {d.decision.decidedBy}, {when(d.decision.decidedAt)}: “{d.decision.reason}”
                  {d.status === "review" && d.reasons.some((r) => r.code === "inputs_changed") ? " — no longer applies; the records changed since." : ""}
                </p>
              )}

              {!mode ? (
                <div className="employee-form-actions">
                  <button type="button" onClick={() => setMode("confirm")}>
                    Confirm proposed allocation
                  </button>
                  <button type="button" onClick={() => setMode("override")}>
                    Correct allocation
                  </button>
                  <button type="button" onClick={() => setMode("exclude")}>
                    Exclude from kg/hour
                  </button>
                  {d.decision && (
                    <button type="button" onClick={() => setMode("reset")}>
                      Reset to automatic
                    </button>
                  )}
                </div>
              ) : (
                <form className={`scale-weighing-void allocation-form${mode === "exclude" ? "" : " is-neutral"}`} onSubmit={submit}>
                  <p>
                    {mode === "confirm" && "Share the bin's kilograms by picking minutes, as calculated above."}
                    {mode === "override" && "Untick an accidental scan or a contribution that was emptied before weighing: it gets neither kilograms nor minutes."}
                    {mode === "exclude" && "The bin will count for nobody's kg/hour."}
                    {mode === "reset" && "Remove the decision: the automatic rules decide this bin again."}
                  </p>
                  {mode === "override" && (
                    <label className="allocation-check">
                      <input type="checkbox" checked={byHand} onChange={(e) => setByHand(e.target.checked)} /> Set kilograms by hand
                    </label>
                  )}
                  {mode === "override" && byHand && (
                    <p className={handSum === netG ? "field-hint" : "error-text"}>
                      Entered {kg(handSum / 1000)} kg of {kg(d.netKg)} kg{handSum === netG ? "" : " — must add up to the net weight"}
                    </p>
                  )}
                  <label className="scale-field">
                    <span className="scale-field-label">Reason</span>
                    <textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} required />
                  </label>
                  <div className="employee-form-actions">
                    <button type="submit" disabled={saving || reason.trim().length < 3 || (mode === "override" && byHand && handSum !== netG)}>
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button type="button" onClick={() => setMode(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </>
          )}

          <h3>History</h3>
          {d.history.length === 0 ? (
            <p className="field-hint">No administrator decisions yet.</p>
          ) : (
            <ol className="scale-weighing-history">
              {d.history.map((h) => (
                <li key={h.id}>
                  <strong>{ACTION_LABELS[h.action]}</strong> · {h.performed_by} · {when(h.performed_at)}
                  <div className="field-hint">“{h.reason}”</div>
                  {h.next && h.next.shares.length > 0 && (
                    <div className="field-hint">
                      {h.next.method === "manual" ? "Kilograms set by hand: " : "Shared by minutes: "}
                      {h.next.shares
                        .map((s) => `${d.contributors.find((c) => c.employeeId === s.employeeId)?.name ?? "?"} ${s.included ? `${kg(s.allocatedGrams / 1000)} kg` : "excluded"}`)
                        .join(", ")}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Modal>
  );
}
