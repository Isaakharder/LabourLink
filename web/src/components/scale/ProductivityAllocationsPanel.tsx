import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../lib/api";
import { ALLOCATION_STATUS_BADGE, ALLOCATION_STATUS_LABELS, AllocationList } from "../../lib/scaleProductivityAllocationTypes";
import { formatTimeInAppTimezone } from "../../lib/timezone";
import { AllocationReviewModal } from "./AllocationReviewModal";

const kg = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 3 });

// Administrator only: the day's weighed bins that more than one employee
// picked into, or that wait for review, and how their kilograms are shared
// for kg/hour (server/src/lib/scaleProductivityAllocations.ts). This never
// changes who a weighing is officially credited to.
export function ProductivityAllocationsPanel({ date }: { date: string }) {
  const { employee } = useAuth();
  const isAdmin = employee?.securityRole === "Administrator";
  const [data, setData] = useState<AllocationList | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isAdmin) return;
    api<AllocationList>(`/api/scale-productivity-allocations?date=${encodeURIComponent(date)}`)
      .then((d) => {
        setData(d ?? null);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [date, isAdmin]);
  useEffect(() => {
    load();
  }, [load]);

  // Not an Administrator, or no Job shows kilograms/hour: nothing to review.
  if (!isAdmin || !data?.activityId) return failed && isAdmin ? <p className="error-text">Could not load the kg/hour allocations</p> : null;
  const toReview = data.bins.filter((b) => b.status === "review").length;

  return (
    <section className="setup-section scale-weighings productivity-allocations" aria-label="Review allocation">
      <h2>
        Review allocation <span className="field-hint">kg/hour · {data.jobs.find((j) => j.id === data.activityId)?.name}</span>
      </h2>
      <p className="field-hint">
        A bin several employees picked into is shared between them by their picking minutes, for kg/hour only. Bins handed over while picking
        continued are shared automatically. A bin is held here, and counts for nobody, when LabourLink can't tell whether it was emptied in between
        (a pause or an overnight handover) or its time is unclear. The official credit is never changed here.
      </p>
      {data.bins.length === 0 ? (
        <p className="placeholder-page">No shared bins or bins to review on this day.</p>
      ) : (
        <>
          {toReview > 0 && (
            <p className="scale-note" role="status">
              {toReview} bin{toReview === 1 ? "" : "s"} to review
            </p>
          )}
          <div className="scale-weighings-table-wrap">
            <table className="employees-table scale-weighings-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Bin</th>
                  <th className="num">Net (kg)</th>
                  <th>Pickers (minutes · share)</th>
                  <th>kg/hour allocation</th>
                  <th>Official credit</th>
                </tr>
              </thead>
              <tbody>
                {data.bins.map((b) => (
                  <tr key={b.weighingId} onClick={() => setOpenId(b.weighingId)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpenId(b.weighingId)}>
                    <td className="scale-col-time">{formatTimeInAppTimezone(b.weighedAt, { seconds: false })}</td>
                    <td className="scale-col-bin">{b.bin}</td>
                    <td className="num">{kg(b.netKg)}</td>
                    <td>
                      {b.contributors.map((c) => (
                        <div key={c.employeeId}>
                          {c.name} · {Math.round(c.matchedMinutes)} min
                          {c.matchedSeconds > 0 ? ` · ${c.percent.toFixed(1)}% · ${kg(c.countedKg ?? c.proposedKg)} kg` : " · scan only"}
                        </div>
                      ))}
                    </td>
                    <td>
                      <span className={`scale-status scale-status-${ALLOCATION_STATUS_BADGE[b.status]}`}>{ALLOCATION_STATUS_LABELS[b.status]}</span>
                      {b.reasons.map((r) => (
                        <div key={r.code} className="field-hint">
                          {r.label}
                        </div>
                      ))}
                    </td>
                    <td>{b.officialCredit.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {openId && <AllocationReviewModal weighingId={openId} activityId={data.activityId} onClose={() => setOpenId(null)} onChanged={load} />}
    </section>
  );
}
