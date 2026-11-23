import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/layout/PageHeader";
import { DateNav } from "../../components/inputs/DateNav";
import { ScaleWeighingDetailModal } from "../../components/scale/ScaleWeighingDetailModal";
import { api, ApiError } from "../../lib/api";
import { ScaleWeighingDay } from "../../lib/scaleWeighingTypes";
import { StatusBadge } from "../../components/scale/StatusBadge";
import { PickingCyclesPanel } from "../../components/scale/PickingCyclesPanel";
import { WeighingRowsCell } from "../../components/scale/WeighingRowsCell";
import { formatTimeInAppTimezone, todayInAppTimezone } from "../../lib/timezone";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "credited", label: "Credited" },
  { value: "pending", label: "Pending" },
  { value: "needs_review", label: "Needs review" },
  { value: "not_credited", label: "Not credited" },
  { value: "expired", label: "Expired" },
  { value: "voided", label: "Voided" },
  // Repeat weighings within five minutes: never reviewed or counted, so not
  // part of Needs review. Shown only when there are any (or it is selected).
  { value: "duplicate", label: "Duplicate" },
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
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ date, status });
    if (carrierId) params.set("carrierId", carrierId);
    if (employeeId) params.set("employeeId", employeeId);
    setLoading(true);
    api<ScaleWeighingDay>(`/api/scale-weighings?${params}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the weighings"))
      .finally(() => setLoading(false));
  }, [date, carrierId, employeeId, status]);

  useEffect(() => {
    load();
  }, [load]);

  const today = todayInAppTimezone();
  function changeDate(next: string) {
    if (!next || next > today) return;
    setDate(next);
    setCarrierId("");
    setEmployeeId("");
  }

  const filtersActive = status !== "all" || !!carrierId || !!employeeId;
  function clearFilters() {
    setStatus("all");
    setCarrierId("");
    setEmployeeId("");
  }

  const t = data?.totals;
  const counts = data?.statusCounts;
  const notes = t
    ? [
        t.trial > 0 ? `${t.trial} trial weighing${t.trial === 1 ? "" : "s"} (credits were off at the station; never counted as a credit)` : null,
        t.duplicates > 0 ? `${t.duplicates} duplicate${t.duplicates === 1 ? "" : "s"} not counted` : null,
        t.voided > 0 ? `${t.voided} voided credit${t.voided === 1 ? "" : "s"} not counted` : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="scale-page">
      <PageHeader title="Scale Weighings" description="Every bin weighed at the weighing station, where it was picked, and who it was credited to." />

      <section className="scale-panel scale-toolbar" aria-label="Day and filters">
        <div className="scale-toolbar-date">
          <DateNav date={date} onChange={changeDate} max={today} label="Choose weighing date" />
          {date !== today && (
            <button type="button" className="scale-button scale-button-quiet" onClick={() => changeDate(today)}>
              Today
            </button>
          )}
        </div>
        <div className="scale-toolbar-filters">
          <label className="scale-field">
            <span className="scale-field-label">Bin</span>
            <select aria-label="Bin" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
              <option value="">All bins</option>
              {data?.filters.bins.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="scale-field">
            <span className="scale-field-label">Employee</span>
            <select aria-label="Employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">All employees</option>
              {data?.filters.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {filtersActive && (
            <button type="button" className="scale-button scale-button-quiet" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </section>

      {error && <p className="error-text">{error}</p>}

      {t && (
        <div className="scale-summary" role="list" aria-label="Day totals">
          <Total label="Net produce" value={`${kg(t.netKg)} kg`} hint={`${t.binsWeighed} bin${t.binsWeighed === 1 ? "" : "s"} weighed`} tone="primary" />
          <Total label="Credited" value={`${kg(t.creditedNetKg)} kg`} hint={`${t.credited} bin${t.credited === 1 ? "" : "s"}`} tone="success" />
          <Total label="Pending" value={String(t.pending)} hint="Waiting for a phone bin choice" onSelect={t.pending > 0 ? () => setStatus("pending") : undefined} />
          <Total
            label="Needs review"
            value={String(t.needsReview)}
            hint={t.needsReview > 0 ? "Held for an administrator" : "Nothing to review"}
            tone={t.needsReview > 0 ? "attention" : undefined}
            onSelect={t.needsReview > 0 ? () => setStatus("needs_review") : undefined}
          />
          <Total label="Never credited" value={String(t.neverCredited)} hint="Needs review or expired" />
        </div>
      )}
      {notes.length > 0 && <p className="scale-note">{notes.join(" · ")}</p>}
      <p className="scale-summary-scope">
        Cards and status counts cover this day{carrierId || employeeId ? " with the Bin and Employee filters" : ""}. Needs review never includes duplicates.
      </p>

      <section className="scale-panel scale-table-panel" aria-label="Weighings">
        <div className="scale-table-header">
          <div className="scale-status-tabs" role="group" aria-label="Status">
            {STATUS_FILTERS.filter((s) => s.value !== "duplicate" || status === "duplicate" || (counts?.duplicate ?? 0) > 0).map((s) => {
              const n = counts?.[s.value];
              return (
                <button
                  key={s.value}
                  type="button"
                  className={`scale-status-tab${status === s.value ? " is-active" : ""}${s.value === "needs_review" && (n ?? 0) > 0 ? " is-attention" : ""}`}
                  aria-pressed={status === s.value}
                  onClick={() => setStatus(s.value)}
                >
                  {s.label}
                  {n !== undefined && (
                    <>
                      {" "}
                      <span className="scale-status-tab-count">{n}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
          {loading && data && <span className="scale-loading">Updating…</span>}
        </div>

        {!data ? (
          !error && <p className="scale-empty">Loading…</p>
        ) : data.weighings.length === 0 ? (
          <div className="scale-empty">
            <p>No weighings{filtersActive ? " match these filters" : " on this day"}.</p>
            {filtersActive && (
              <button type="button" className="scale-button" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="scale-weighings-table-wrap">
            <table className="scale-weighings-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Bin</th>
                  <th>Employee</th>
                  <th>Rows</th>
                  <th className="num">Net (kg)</th>
                  <th className="num scale-col-secondary">Gross (kg)</th>
                  <th className="num scale-col-secondary">Tare (kg)</th>
                  <th>Status</th>
                  <th className="scale-col-optional">RFID tag</th>
                  <th className="scale-col-optional">Station</th>
                </tr>
              </thead>
              <tbody>
                {data.weighings.map((w) => (
                  <tr
                    key={w.id}
                    className={w.countsForProduction ? undefined : "scale-weighing-not-counted"}
                    onClick={() => setOpenId(w.id)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setOpenId(w.id)}
                  >
                    <td className="scale-col-time">{formatTimeInAppTimezone(w.weighedAt, { seconds: false })}</td>
                    <td className="scale-col-bin">{w.bin.name}</td>
                    <td>{w.employee?.name ?? <span className="scale-muted">—</span>}</td>
                    <td className="scale-col-rows">
                      <WeighingRowsCell rows={w.rows} />
                    </td>
                    <td className="num scale-col-net">{kg(w.netKg)}</td>
                    <td className="num scale-col-secondary">{kg(w.grossKg)}</td>
                    <td className="num scale-col-secondary">{kg(w.tareKg)}</td>
                    <td>
                      <StatusBadge row={w} />
                    </td>
                    <td className="scale-weighing-tag scale-col-optional">{w.rfidTag}</td>
                    <td className="scale-col-optional">{w.stationName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <PickingCyclesPanel onChanged={load} />
      {openId && <ScaleWeighingDetailModal weighingId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function Total({
  label,
  value,
  hint,
  tone,
  onSelect,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "primary" | "success" | "attention";
  onSelect?: () => void;
}) {
  const className = `scale-summary-card${tone ? ` is-${tone}` : ""}${onSelect ? " is-clickable" : ""}`;
  const body = (
    <>
      <span className="scale-summary-label">{label}</span>
      <span className="scale-summary-value">{value}</span>
      {hint && <span className="scale-summary-hint">{hint}</span>}
    </>
  );
  return (
    <div className={className} role="listitem">
      {onSelect ? (
        <button type="button" className="scale-summary-button" onClick={onSelect} aria-label={`${label}: ${value}. Show these weighings`}>
          {body}
        </button>
      ) : (
        body
      )}
    </div>
  );
}
