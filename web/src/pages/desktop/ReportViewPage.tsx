import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import {
  ACTIVITY_METRIC_LABELS,
  ActivityMetric,
  ActivityReportData,
  DAILY_METRIC_ELIGIBLE_ACTIVITY_METRICS,
  DateRange,
  PAYROLL_METRIC_LABELS,
  PayrollMetric,
  PayrollReportData,
  PIVOT_ELIGIBLE_PAYROLL_METRICS,
  SavedReportDetail,
  WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS,
  WEEKLY_TOTAL_METRIC_LABELS,
  formatPayrollDuration,
  speedUnitAbbreviationNote,
} from "../../lib/reportTypes";
import { ReportDateFilterPanel } from "../../components/reports/ReportDateFilterPanel";
import { ReportPivotTable } from "../../components/reports/ReportPivotTable";
import { ReportPreviewModal } from "../../components/reports/ReportPreviewModal";
import { ReportEmployeeSelectDropdown } from "../../components/reports/ReportEmployeeSelectDropdown";
import { buildActivityPivotGrid, buildPayrollPivotGrid, PivotGrid } from "../../lib/reportPivot";
import { exportPivotCsv, exportPivotPdf, printReport, ReportOrientation } from "../../lib/reportExport";
import { startOfWeekMonday, addCalendarDays, todayInAppTimezone } from "../../lib/timezone";

// Payroll's extra sub-table metrics — a different grain than the matrix
// (whole-range per employee, or per employee+activity), so they render as
// their own tables below the pivot rather than as pivot columns. Unchanged
// from before this pivot rework.
const PAYROLL_SUBTABLE_METRICS = ["daysWorked", "activityBreakdown", "weeklyTotals"] as const;

const DEFAULT_DAILY_METRIC: ActivityMetric = "workTime";
const DEFAULT_WEEKLY_TOTALS: ActivityMetric[] = ["activityHours"];

interface ReportEmployeeOption {
  id: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

function defaultDateRange(): DateRange {
  const start = startOfWeekMonday(todayInAppTimezone());
  return { start, end: addCalendarDays(start, 6) };
}

// Activity and Payroll reports use two entirely different metric-selection
// models, kept in separate state below since hooks can't be conditional:
//   - Payroll: unchanged — a flat `metrics` checkbox list plus the
//     `pivotMetric` "Show:" dropdown selecting which checked metric
//     currently drives the pivot cells/Employee Total column.
//   - Activity: `dailyMetric` (single, shown under each Mon-Sun date
//     column) + `weeklyTotals` (one or more independently-saved right-hand
//     summary columns) — no "Show:" dropdown, no checkbox-plus-dropdown
//     workflow; see reportPivot.ts's buildActivityPivotGrid. Both fall back
//     to DEFAULT_DAILY_METRIC/DEFAULT_WEEKLY_TOTALS for a report saved
//     before this redesign (configuration.dailyMetric/weeklyTotals absent).
export function ReportViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<SavedReportDetail | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange());
  const [metrics, setMetrics] = useState<string[]>([]);
  const [dailyMetric, setDailyMetric] = useState<ActivityMetric>(DEFAULT_DAILY_METRIC);
  const [weeklyTotals, setWeeklyTotals] = useState<ActivityMetric[]>(DEFAULT_WEEKLY_TOTALS);
  const [data, setData] = useState<ActivityReportData | PayrollReportData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [savingMetrics, setSavingMetrics] = useState(false);
  const [editingMetrics, setEditingMetrics] = useState(false);
  const [pivotMetric, setPivotMetric] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"print" | "pdf" | null>(null);
  const [employees, setEmployees] = useState<ReportEmployeeOption[] | null>(null);

  useEffect(() => {
    if (!id) return;
    api<{ report: SavedReportDetail }>(`/api/reports/${id}`)
      .then((res) => {
        setReport(res.report);
        setMetrics(res.report.configuration.metrics ?? []);
        setDailyMetric((res.report.configuration.dailyMetric as ActivityMetric) ?? DEFAULT_DAILY_METRIC);
        setWeeklyTotals((res.report.configuration.weeklyTotals as ActivityMetric[]) ?? DEFAULT_WEEKLY_TOTALS);
        if (res.report.configuration.lastDateRange) setDateRange(res.report.configuration.lastDateRange);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load report"));
  }, [id]);

	useEffect(() => {
		api<{ employees: ReportEmployeeOption[] }>("/api/employees")
			.then((res) => setEmployees(res.employees))
			.catch(() => setEmployees([]));
	}, []);

  // No employeeIds param — the employee filter is now entirely server-side,
  // derived from THIS report's own saved employeeSelectionMode/employeeIds
  // (see reports.ts's GET /:id/data). Reloading this page, saving a new
  // selection (which calls loadData again after the PATCH resolves), print,
  // CSV, and PDF all end up reading the exact same filtered response.
  const loadData = useCallback(() => {
    if (!id) return;
    setDataError(null);
    const params = new URLSearchParams({ start: dateRange.start, end: dateRange.end });
    api<{ data: ActivityReportData | PayrollReportData }>(
      `/api/reports/${id}/data?${params.toString()}`
    )
      .then((res) => setData(res.data))
      .catch((err) => setDataError(err instanceof ApiError ? err.message : "Could not generate report"));
  }, [id, dateRange]);

  useEffect(() => {
    if (report) loadData();
  }, [report, loadData]);

  function handleDateRangeChange(range: DateRange) {
    setDateRange(range);
    if (id) {
      api(`/api/reports/${id}`, { method: "PATCH", body: JSON.stringify({ lastDateRange: range }) }).catch(() => {});
    }
  }

  async function savePayrollMetrics() {
    if (!id) return;
    setSavingMetrics(true);
    try {
      await api(`/api/reports/${id}`, { method: "PATCH", body: JSON.stringify({ metrics }) });
      setEditingMetrics(false);
      loadData();
    } catch (err) {
      setDataError(err instanceof ApiError ? err.message : "Could not save metrics");
    } finally {
      setSavingMetrics(false);
    }
  }

  async function saveActivityConfig() {
    if (!id) return;
    setSavingMetrics(true);
    try {
      await api(`/api/reports/${id}`, { method: "PATCH", body: JSON.stringify({ dailyMetric, weeklyTotals }) });
      setEditingMetrics(false);
      loadData();
    } catch (err) {
      setDataError(err instanceof ApiError ? err.message : "Could not save metrics");
    } finally {
      setSavingMetrics(false);
    }
  }

  function toggleMetric(key: string) {
    setMetrics((prev) => (prev.includes(key) ? prev.filter((m) => m !== key) : [...prev, key]));
  }

  function toggleWeeklyTotal(key: ActivityMetric) {
    setWeeklyTotals((prev) => (prev.includes(key) ? prev.filter((m) => m !== key) : [...prev, key]));
  }

  // Persists the dropdown's staged selection to the report's own
  // server-side definition, then reloads data so screen/CSV/PDF/print all
  // immediately reflect it. Throws back to the dropdown on failure (via
  // ApiError) so it can show the error inline and stay open rather than
  // silently discarding the user's staged edit.
  async function saveEmployeeSelection(mode: "all" | "selected", ids: string[]) {
    if (!id) return;
    await api(`/api/reports/${id}`, { method: "PATCH", body: JSON.stringify({ employeeSelectionMode: mode, employeeIds: ids }) });
    setReport((prev) => (prev ? { ...prev, employeeSelectionMode: mode, employeeIds: ids } : prev));
    loadData();
  }

  const isActivity = report?.reportType === "activity";

  // Payroll only — which configured metrics can actually fill a pivot cell
  // (falls back to "workTime" if the report has none selected, e.g. an
  // older report), driving the "Show:" dropdown. Activity reports have no
  // such dropdown — dailyMetric is a single saved value, not chosen from
  // among several checked metrics.
  const pivotEligibleMetrics = useMemo(() => {
    if (!report || isActivity) return [];
    return PIVOT_ELIGIBLE_PAYROLL_METRICS.filter((m) => metrics.includes(m));
  }, [report, isActivity, metrics]);
  const effectivePivotMetrics = pivotEligibleMetrics.length > 0 ? pivotEligibleMetrics : ["workTime"];

  useEffect(() => {
    if (isActivity) return;
    if (pivotMetric && effectivePivotMetrics.includes(pivotMetric)) return;
    setPivotMetric(effectivePivotMetrics.includes("workTime") ? "workTime" : effectivePivotMetrics[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePivotMetrics.join(","), isActivity]);

  const pivotGrid: PivotGrid | null = useMemo(() => {
    if (!report || !data) return null;
    if (isActivity) {
      const effectiveWeeklyTotals = weeklyTotals.length > 0 ? weeklyTotals : DEFAULT_WEEKLY_TOTALS;
      return buildActivityPivotGrid(data as ActivityReportData, dateRange, dailyMetric, effectiveWeeklyTotals);
    }
    if (!pivotMetric) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return buildPayrollPivotGrid(data as PayrollReportData, dateRange, pivotMetric as any);
  }, [report, data, pivotMetric, dateRange, isActivity, dailyMetric, weeklyTotals]);

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!report) return <p>Loading...</p>;

  const metricCatalog: string[] = [...PIVOT_ELIGIBLE_PAYROLL_METRICS, ...PAYROLL_SUBTABLE_METRICS];

  const payrollData = !isActivity ? (data as PayrollReportData | null) : null;

  // The metric label shown in the CSV/PDF filename/subtitle and the Print/
  // PDF preview's meta line — always describes the DAILY metric (the one
  // driving the pivot cells under Mon-Sun), never the weekly-total
  // column(s): Activity's own saved dailyMetric, or Payroll's "Show:"
  // dropdown selection.
  const currentMetricLabel = isActivity
    ? ACTIVITY_METRIC_LABELS[dailyMetric]
    : pivotMetric
      ? PAYROLL_METRIC_LABELS[pivotMetric as PayrollMetric]
      : "";

  // Only ever set for an Activity report currently showing the Average
  // Speed daily metric, and only when the activity's speed_unit is one of
  // the two units this app abbreviates — see reportTypes.ts's
  // speedUnitAbbreviationNote. null otherwise, which is exactly when the
  // note (and the cell abbreviation it explains) should be hidden.
  const activitySpeedUnit = isActivity && data ? (data as ActivityReportData).activity.speedUnit : null;
  const speedUnitNote = isActivity && dailyMetric === "averageSpeed" ? speedUnitAbbreviationNote(activitySpeedUnit) : null;

  function handleExportCsv() {
    // CSV has no page orientation, so it stays a direct action — no preview
    // step, per the brief.
    if (!pivotGrid || !report) return;
    exportPivotCsv(report, pivotGrid, currentMetricLabel);
  }

  function handlePreviewConfirm(orientation: ReportOrientation) {
    if (!pivotGrid || !report) return;
    if (previewMode === "print") {
      printReport(orientation);
    } else if (previewMode === "pdf") {
      exportPivotPdf(report, dateRange, pivotGrid, currentMetricLabel, orientation, speedUnitNote);
    }
    setPreviewMode(null);
  }

  return (
    <section className="employees-page report-view">
      <header className="report-view-header-compact">
        <div className="report-view-header-left">
          <button type="button" onClick={() => navigate("/reports")} className="report-back-button">
            ← Reports
          </button>
          <div>
            <h1>{report.name}</h1>
            <p className="report-view-meta">
              {isActivity ? "Activity Report" : "Payroll Report"}
              {report.activity ? ` · ${report.activity.name}` : ""}
              {" · "}
              {dateRange.start} – {dateRange.end}
            </p>
          </div>
        </div>
        <div className="report-view-actions">
          <button type="button" onClick={() => setEditingMetrics((v) => !v)}>
            {editingMetrics ? "Close Metrics" : "Edit Metrics"}
          </button>
          <button type="button" disabled={!pivotGrid} onClick={() => setPreviewMode("print")}>
            Print
          </button>
          <button type="button" disabled={!pivotGrid} onClick={handleExportCsv}>
            Export CSV
          </button>
          <button type="button" disabled={!pivotGrid} onClick={() => setPreviewMode("pdf")}>
            Export PDF
          </button>
        </div>
      </header>

      <div className="report-employee-select-row">
        <span className="report-employee-select-label">Employees</span>
        <ReportEmployeeSelectDropdown
          employees={employees}
          committedMode={report.employeeSelectionMode}
          committedIds={report.employeeIds}
          onSave={saveEmployeeSelection}
        />
      </div>

      {editingMetrics && isActivity && (
        <fieldset className="report-metrics-fieldset">
          <legend>Daily metric &amp; weekly totals</legend>
          <label className="report-form-label">
            Daily metric (shown under each Mon–Sun date column)
            <select value={dailyMetric} onChange={(e) => setDailyMetric(e.target.value as ActivityMetric)}>
              {DAILY_METRIC_ELIGIBLE_ACTIVITY_METRICS.map((m) => (
                <option key={m} value={m}>
                  {ACTIVITY_METRIC_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <p>Weekly totals (right-hand summary columns)</p>
          <div className="report-metrics-grid">
            {WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS.map((m) => (
              <label key={m} className="report-metric-checkbox">
                <input type="checkbox" checked={weeklyTotals.includes(m)} onChange={() => toggleWeeklyTotal(m)} />
                {WEEKLY_TOTAL_METRIC_LABELS[m]}
              </label>
            ))}
          </div>
          {weeklyTotals.length === 0 && <p className="error-text">At least one weekly total must be selected</p>}
          <div className="employee-form-actions">
            <button
              type="button"
              className="employee-form-save"
              disabled={weeklyTotals.length === 0 || savingMetrics}
              onClick={saveActivityConfig}
            >
              {savingMetrics ? "Saving..." : "Save"}
            </button>
          </div>
        </fieldset>
      )}

      {editingMetrics && !isActivity && (
        <fieldset className="report-metrics-fieldset">
          <legend>Metrics</legend>
          <div className="report-metrics-grid">
            {metricCatalog.map((m) => (
              <label key={m} className="report-metric-checkbox">
                <input type="checkbox" checked={metrics.includes(m)} onChange={() => toggleMetric(m)} />
                {PAYROLL_METRIC_LABELS[m as PayrollMetric]}
              </label>
            ))}
          </div>
          <div className="employee-form-actions">
            <button
              type="button"
              className="employee-form-save"
              disabled={metrics.length === 0 || savingMetrics}
              onClick={savePayrollMetrics}
            >
              {savingMetrics ? "Saving..." : "Save metrics"}
            </button>
          </div>
        </fieldset>
      )}

      {dataError && <p className="error-text">{dataError}</p>}

      <div className="report-view-body">
        <ReportDateFilterPanel value={dateRange} onChange={handleDateRangeChange} />

        <div className="report-view-main">
          {!data ? (
            <p>Loading report data...</p>
          ) : (
            <>
              {!isActivity && effectivePivotMetrics.length > 1 && (
                <div className="report-pivot-metric-select">
                  <label>
                    Show:
                    <select value={pivotMetric ?? ""} onChange={(e) => setPivotMetric(e.target.value)}>
                      {effectivePivotMetrics.map((m) => (
                        <option key={m} value={m}>
                          {PAYROLL_METRIC_LABELS[m as PayrollMetric]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {/* Always rendered (never hidden by print CSS, unlike the
                  "Show:" selector above) so the H:MM indication survives
                  Print/PDF too, not just the live screen — see index.css's
                  @media print block, which hides .report-pivot-metric-select
                  but has no rule targeting this class. */}
              {!isActivity && pivotGrid && pivotGrid.employees.length > 0 && (
                <p className="report-pivot-unit-note">Hours shown as H:MM (hours:minutes) — not decimal.</p>
              )}
              {isActivity && pivotGrid && pivotGrid.employees.length > 0 && speedUnitNote && (
                <p className="report-pivot-unit-note">{speedUnitNote}</p>
              )}
              {pivotGrid && pivotGrid.employees.length === 0 ? (
                <p className="placeholder-page">No data for this date range.</p>
              ) : (
                pivotGrid && <ReportPivotTable grid={pivotGrid} />
              )}

              {payrollData && metrics.includes("daysWorked") && payrollData.daysWorkedByEmployee.length > 0 && (
                <div className="report-subtable">
                  <h2>Days worked</h2>
                  <table className="employees-table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th className="report-col-right">Days worked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payrollData.daysWorkedByEmployee.map((r) => (
                        <tr key={r.employeeId}>
                          <td>{r.employeeName}</td>
                          <td className="report-col-right">{r.daysWorked}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {payrollData && metrics.includes("activityBreakdown") && payrollData.activityBreakdown.length > 0 && (
                <div className="report-subtable">
                  <h2>Activity breakdown</h2>
                  <table className="employees-table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Activity</th>
                        <th className="report-col-right">Hours (H:MM)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payrollData.activityBreakdown.map((r, i) => {
                        const employeeName =
                          payrollData.daysWorkedByEmployee.find((e) => e.employeeId === r.employeeId)?.employeeName ?? r.employeeId;
                        return (
                          <tr key={i}>
                            <td>{employeeName}</td>
                            <td>{r.activityName}</td>
                            <td className="report-col-right">{formatPayrollDuration(r.workSeconds)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {payrollData && metrics.includes("weeklyTotals") && payrollData.weeklyTotals.length > 0 && (
                <div className="report-subtable">
                  <h2>Weekly totals (all employees)</h2>
                  <table className="employees-table">
                    <thead>
                      <tr>
                        <th>Week</th>
                        <th className="report-col-right">Work hours (H:MM)</th>
                        <th className="report-col-right">Break hours (H:MM)</th>
                        <th className="report-col-right">Paid hours (H:MM)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payrollData.weeklyTotals.map((w) => (
                        <tr key={w.weekStart}>
                          <td>
                            {w.weekStart} – {w.weekEnd}
                          </td>
                          <td className="report-col-right">{formatPayrollDuration(w.workSeconds)}</td>
                          <td className="report-col-right">{formatPayrollDuration(w.breakSeconds)}</td>
                          <td className="report-col-right">{formatPayrollDuration(w.paidSeconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <p className="report-generated-at print-only">Generated {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}</p>

      {previewMode && pivotGrid && (
        <ReportPreviewModal
          report={report}
          dateRange={dateRange}
          grid={pivotGrid}
          metricLabel={currentMetricLabel}
          mode={previewMode}
          note={speedUnitNote}
          onClose={() => setPreviewMode(null)}
          onConfirm={handlePreviewConfirm}
        />
      )}
    </section>
  );
}
