import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "../../components/layout/PageHeader";
import { ScaleWeighingDetailModal } from "../../components/scale/ScaleWeighingDetailModal";
import { api, ApiError } from "../../lib/api";
import { ScaleWeighingDay } from "../../lib/scaleWeighingTypes";
import { StatusBadge } from "../../components/scale/StatusBadge";
import { addCalendarDays, formatDateLong, formatTimeInAppTimezone, todayInAppTimezone } from "../../lib/timezone";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "credited", label: "Credited" },
  { value: "pending", label: "Pending" },
  { value: "needs_review", label: "Needs review" },
  { value: "expired", label: "Expired" },
  { value: "voided", label: "Voided" },
  { value: "not_credited", label: "Not credited" },
];

const kg = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

// Every weighing the weighing stations recorded, one day at a time
// (server/src/routes/scaleWeighings.ts). Production totals leave out voided
// and duplicate weighings; credited kilograms count only live credits.
export function ScaleWeighingsPage() {
  const [date, setDate] = useState(todayInAppTimezone);
  const [carrierId, setCarrierId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [status, setStatus] = useState("all");
  const [data, setData] = useState<ScaleWeighingDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ date, status });
    if (carrierId) params.set("carrierId", carrierId);
    if (employeeId) params.set("employeeId", employeeId);
    api<ScaleWeighingDay>(`/api/scale-weighings?${params}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the weighings"));
  }, [date, carrierId, employeeId, status]);

  useEffect(() => {
    load();
  }, [load]);

  function changeDate(next: string) {
    if (!next) return;
    setDate(next);
    setCarrierId("");
    setEmployeeId("");
  }

  const t = data?.totals;
  return (
    <>
      <PageHeader title="Scale Weighings" description="Every bin weighed at the weighing station, and who it was credited to." />
      <section className="setup-section scale-weighings">
        <div className="scale-weighings-toolbar">
          <div className="scale-weighings-date">
            <button type="button" aria-label="Previous day" onClick={() => changeDate(addCalendarDays(date, -1))}>
              <ChevronLeft size={16} />
            </button>
            <input type="date" aria-label="Date" value={date} max={todayInAppTimezone()} onChange={(e) => changeDate(e.target.value)} />
            <button type="button" aria-label="Next day" disabled={date >= todayInAppTimezone()} onClick={() => changeDate(addCalendarDays(date, 1))}>
              <ChevronRight size={16} />
            </button>
            {date !== todayInAppTimezone() && (
              <button type="button" onClick={() => changeDate(todayInAppTimezone())}>
                Today
              </button>
            )}
          </div>
          <select aria-label="Bin" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
            <option value="">All bins</option>
            {data?.filters.bins.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select aria-label="Employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">All employees</option>
            {data?.filters.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <h2 className="scale-weighings-day">{formatDateLong(date)}</h2>
        {error && <p className="error-text">{error}</p>}

        {t && (
          <div className="scale-weighings-totals" role="list" aria-label="Day totals">
            <Total label="Net produce" value={`${kg(t.netKg)} kg`} />
            <Total label="Bins weighed" value={String(t.binsWeighed)} />
            <Total label="Credited" value={`${kg(t.creditedNetKg)} kg`} hint={`${t.credited} bins`} />
            <Total label="Pending" value={String(t.pending)} />
            <Total label="Needs review" value={String(t.needsReview)} attention={t.needsReview > 0} />
            <Total label="Never credited" value={String(t.neverCredited)} />
          </div>
        )}
        {t && (t.trial > 0 || t.duplicates > 0 || t.voided > 0) && (
          <p className="field-hint">
            {[
              t.trial > 0 ? `${t.trial} trial weighing${t.trial === 1 ? "" : "s"} (credits were off at the station; never counted as a credit)` : null,
              t.duplicates > 0 ? `${t.duplicates} duplicate${t.duplicates === 1 ? "" : "s"} not counted` : null,
              t.voided > 0 ? `${t.voided} voided credit${t.voided === 1 ? "" : "s"} not counted` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}

        {!data ? (
          !error && <p>Loading...</p>
        ) : data.weighings.length === 0 ? (
          <p className="placeholder-page">No weighings{status !== "all" || carrierId || employeeId ? " match these filters" : " on this day"}.</p>
        ) : (
          <div className="scale-weighings-table-wrap">
            <table className="employees-table scale-weighings-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Bin</th>
                  <th className="scale-col-optional">RFID tag</th>
                  <th className="num">Gross (kg)</th>
                  <th className="num">Tare (kg)</th>
                  <th className="num">Net (kg)</th>
                  <th>Employee</th>
                  <th>Status</th>
                  <th className="scale-col-optional">Station</th>
                </tr>
              </thead>
              <tbody>
                {data.weighings.map((w) => (
                  <tr key={w.id} className={w.countsForProduction ? undefined : "scale-weighing-not-counted"} onClick={() => setOpenId(w.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpenId(w.id)}>
                    <td>{formatTimeInAppTimezone(w.weighedAt, { seconds: false })}</td>
                    <td>{w.bin.name}</td>
                    <td className="scale-weighing-tag scale-col-optional">{w.rfidTag}</td>
                    <td className="num">{kg(w.grossKg)}</td>
                    <td className="num">{kg(w.tareKg)}</td>
                    <td className="num">{kg(w.netKg)}</td>
                    <td>{w.employee?.name ?? "—"}</td>
                    <td>
                      <StatusBadge row={w} />
                    </td>
                    <td className="scale-col-optional">{w.stationName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {openId && (
        <ScaleWeighingDetailModal
          weighingId={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
    </>
  );
}

function Total({ label, value, hint, attention }: { label: string; value: string; hint?: string; attention?: boolean }) {
  return (
    <div className={`scale-weighings-total${attention ? " is-attention" : ""}`} role="listitem">
      <span className="scale-weighings-total-label">{label}</span>
      <span className="scale-weighings-total-value">{value}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}
