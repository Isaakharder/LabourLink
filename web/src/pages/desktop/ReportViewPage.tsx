import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import {
  ACTIVITY_METRIC_LABELS,
  ActivityReportData,
  DateRange,
  PAYROLL_METRIC_LABELS,
  PayrollReportData,
  PIVOT_ELIGIBLE_ACTIVITY_METRICS,
  PIVOT_ELIGIBLE_PAYROLL_METRICS,
  SavedReportDetail,
  formatPayrollDuration,
} from "../../lib/reportTypes";
import { ReportDateFilterPanel } from "../../components/reports/ReportDateFilterPanel";
import { ReportPivotTable } from "../../components/reports/ReportPivotTable";
import { ReportPreviewModal } from "../../components/reports/ReportPreviewModal";
import { buildActivityPivotGrid, buildPayrollPivotGrid, PivotGrid } from "../../lib/reportPivot";
import { exportPivotCsv, exportPivotPdf, printReport, ReportOrientation } from "../../lib/reportExport";
import { startOfWeekMonday, addCalendarDays, todayInAppTimezone } from "../../lib/timezone";

// Payroll's extra sub-table metrics — a different grain than the matrix
// (whole-range per employee, or per employee+activity), so they render as
// their own tables below the pivot rather than as pivot columns. Unchanged
// from before this pivot rework.
const PAYROLL_SUBTABLE_METRICS = ["daysWorked", "activityBreakdown", "weeklyTotals"] as const;

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

export function ReportViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<SavedReportDetail | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange());
  const [metrics, setMetrics] = useState<string[]>([]);
  const [data, setData] = useState<ActivityReportData | PayrollReportData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [savingMetrics, setSavingMetrics] = useState(false);
  const [editingMetrics, setEditingMetrics] = useState(false);
  const [pivotMetric, setPivotMetric] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"print" | "pdf" | null>(null);
  const [employees, setEmployees] = useState<ReportEmployeeOption[] | null>(null);
  const [employeeFilterOpen, setEmployeeFilterOpen] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);

  useEffect(() => {
    if (!id) return;
    api<{ report: SavedReportDetail }>(`/api/reports/${id}`)
      .then((res) => {
        setReport(res.report);
        setMetrics(res.report.configuration.metrics ?? []);
        if (res.report.configuration.lastDateRange) setDateRange(res.report.configuration.lastDateRange);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load report"));
  }, [id]);

	useEffect(() => {
		api<{ employees: ReportEmployeeOption[] }>("/api/employees")
			.then((res) => setEmployees(res.employees))
			.catch(() => setEmployees([]));
	}, []);

  const loadData = useCallback(() => {
    if (!id) return;
    setDataError(null);
    const params = new URLSearchParams({ start: dateRange.start, end: dateRange.end });
    if (selectedEmployeeIds.length > 0) {
      params.set("employeeIds", selectedEmployeeIds.join(","));
    }
    api<{ data: ActivityReportData | PayrollReportData }>(
      `/api/reports/${id}/data?${params.toString()}`
    )
      .then((res) => setData(res.data))
      .catch((err) => setDataError(err instanceof ApiError ? err.message : "Could not generate report"));
  }, [id, dateRange, selectedEmployeeIds]);

  useEffect(() => {
    if (report) loadData();
  }, [report, loadData]);

  function handleDateRangeChange(range: DateRange) {
    setDateRange(range);
    if (id) {
      api(`/api/reports/${id}`, { method: "PATCH", body: JSON.stringify({ lastDateRange: range }) }).catch(() => {});
    }
  }

  async function saveMetrics() {
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

  function toggleMetric(key: string) {
    setMetrics((prev) => (prev.includes(key) ? prev.filter((m) => m !== key) : [...prev, key]));
  }

  function toggleEmployee(id: string) {
    setSelectedEmployeeIds((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  }

  const isActivity = report?.reportType === "activity";
  const selectedEmployeeIdSet = useMemo(() => new Set(selectedEmployeeIds), [selectedEmployeeIds]);
  const selectedEmployeeCount = selectedEmployeeIds.length;
  const employeeSearchTerm = employeeSearch.trim().toLowerCase();
  const filteredEmployees = useMemo(() => {
    const list = employees ?? [];
    if (!employeeSearchTerm) return list;
    return list.filter((employee) =>
      `${employee.firstName} ${employee.lastName}`.toLowerCase().includes(employeeSearchTerm)
    );
  }, [employees, employeeSearchTerm]);

  // Which configured metrics can actually fill a pivot cell for this report
  // type — falls back to a sensible default ("workTime") if the report has
  // none selected (e.g. an older report saved before this pivot redesign),
  // so the table is never empty.
  const pivotEligibleMetrics = useMemo(() => {
    if (!report) return [];
    const eligible = isActivity ? PIVOT_ELIGIBLE_ACTIVITY_METRICS : PIVOT_ELIGIBLE_PAYROLL_METRICS;
    return eligible.filter((m) => metrics.includes(m));
  }, [report, isActivity, metrics]);
  const effectivePivotMetrics = pivotEligibleMetrics.length > 0 ? pivotEligibleMetrics : ["workTime"];

  useEffect(() => {
    if (pivotMetric && effectivePivotMetrics.includes(pivotMetric)) return;
    setPivotMetric(effectivePivotMetrics.includes("workTime") ? "workTime" : effectivePivotMetrics[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePivotMetrics.join(",")]);

  const pivotGrid: PivotGrid | null = useMemo(() => {
    if (!report || !data || !pivotMetric) return null;
    if (isActivity) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return buildActivityPivotGrid(data as ActivityReportData, dateRange, pivotMetric as any);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return buildPayrollPivotGrid(data as PayrollReportData, dateRange, pivotMetric as any);
  }, [report, data, pivotMetric, dateRange, isActivity]);

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!report) return <p>Loading...</p>;

  const metricLabels: Record<string, string> = isActivity ? ACTIVITY_METRIC_LABELS : PAYROLL_METRIC_LABELS;
  const metricCatalog: string[] = isActivity
    ? PIVOT_ELIGIBLE_ACTIVITY_METRICS
    : [...PIVOT_ELIGIBLE_PAYROLL_METRICS, ...PAYROLL_SUBTABLE_METRICS];

  const payrollData = !isActivity ? (data as PayrollReportData | null) : null;

  function handleExportCsv() {
    // CSV has no page orientation, so it stays a direct action — no preview
    // step, per the brief.
    if (!pivotGrid || !pivotMetric || !report) return;
    exportPivotCsv(report, pivotGrid, metricLabels[pivotMetric]);
  }

  function handlePreviewConfirm(orientation: ReportOrientation) {
    if (!pivotGrid || !pivotMetric || !report) return;
    if (previewMode === "print") {
      printReport(orientation);
    } else if (previewMode === "pdf") {
      exportPivotPdf(report, dateRange, pivotGrid, metricLabels[pivotMetric], orientation);
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
              {selectedEmployeeCount > 0 ? ` · ${selectedEmployeeCount} employee${selectedEmployeeCount === 1 ? "" : "s"} selected` : ""}
            </p>
          </div>
        </div>
        <div className="report-view-actions">
          <button type="button" onClick={() => setEmployeeFilterOpen((open) => !open)}>
            {employeeFilterOpen
              ? "Close Employees"
              : selectedEmployeeCount > 0
                ? `Employees (${selectedEmployeeCount})`
                : "Employees"}
          </button>
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

      {employeeFilterOpen && (
        <section className="report-employee-filter-bar">
          <div className="report-employee-filter-toolbar">
            <div>
              <h2>Employees</h2>
              <p>{selectedEmployeeCount > 0 ? `${selectedEmployeeCount} selected` : "Showing all employees"}</p>
            </div>
            <div className="report-employee-filter-actions">
              <button type="button" onClick={() => setSelectedEmployeeIds([])} disabled={selectedEmployeeCount === 0}>
                Clear
              </button>
              <button
                type="button"
                onClick={() => setSelectedEmployeeIds((employees ?? []).map((employee) => employee.id))}
                disabled={!employees || employees.length === 0}
              >
                Select all
              </button>
            </div>
          </div>

          <input
            type="text"
            className="report-employee-search"
            placeholder="Search employees..."
            value={employeeSearch}
            onChange={(e) => setEmployeeSearch(e.target.value)}
          />

          <div className="report-employee-filter-list">
            {!employees ? (
              <p className="placeholder-page">Loading employees...</p>
            ) : filteredEmployees.length === 0 ? (
              <p className="placeholder-page">No employees match.</p>
            ) : (
              filteredEmployees.map((employee) => (
                <label key={employee.id} className="report-employee-filter-item">
                  <input
                    type="checkbox"
                    checked={selectedEmployeeIdSet.has(employee.id)}
                    onChange={() => toggleEmployee(employee.id)}
                  />
                  <span>
                    {employee.firstName} {employee.lastName}
                  </span>
                  {!employee.isActive && <span className="report-employee-inactive">Inactive</span>}
                </label>
              ))
            )}
          </div>
        </section>
      )}

      {editingMetrics && (
        <fieldset className="report-metrics-fieldset">
          <legend>{isActivity ? "Pivot metrics" : "Metrics"}</legend>
          <div className="report-metrics-grid">
            {metricCatalog.map((m) => (
              <label key={m} className="report-metric-checkbox">
                <input type="checkbox" checked={metrics.includes(m)} onChange={() => toggleMetric(m)} />
                {metricLabels[m]}
              </label>
            ))}
          </div>
          <div className="employee-form-actions">
            <button type="button" className="employee-form-save" disabled={metrics.length === 0 || savingMetrics} onClick={saveMetrics}>
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
              {effectivePivotMetrics.length > 1 && (
                <div className="report-pivot-metric-select">
                  <label>
                    Show:
                    <select value={pivotMetric ?? ""} onChange={(e) => setPivotMetric(e.target.value)}>
                      {effectivePivotMetrics.map((m) => (
                        <option key={m} value={m}>
                          {metricLabels[m]}
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

      {previewMode && pivotGrid && pivotMetric && (
        <ReportPreviewModal
          report={report}
          dateRange={dateRange}
          grid={pivotGrid}
          metricLabel={metricLabels[pivotMetric]}
          mode={previewMode}
          onClose={() => setPreviewMode(null)}
          onConfirm={handlePreviewConfirm}
        />
      )}
    </section>
  );
}
