import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { startOfWeekMonday, addCalendarDays, todayInAppTimezone } from "../../lib/timezone";

interface ActivityOption {
  id: string;
  name: string;
  isActive: boolean;
}

interface EmployeeOption {
  id: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

type Grouping =
  | { kind: "completed"; completionId: string; groupQuantityPerRow: number; groupDurationSeconds: number; groupSegmentCount: number }
  | { kind: "unresolved"; cycleIndex: number; candidatesInCycle: number; ambiguous: boolean; groupDurationSeconds: number; groupSegmentCount: number }
  | { kind: "in-progress" }
  | { kind: "not-density-eligible" };

interface AuditSegment {
  segmentId: string;
  employeeId: string;
  employeeName: string;
  rowLabel: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  densityType: "plants" | "stems" | null;
  densityCountPerRow: number | null;
  completionGrouping: Grouping;
  attributedQuantity: number | null;
  includedInReport: boolean;
  exclusionReason: string | null;
}

interface AuditResponse {
  activity: { id: string; name: string };
  employee: { id: string; firstName: string; lastName: string };
  segments: AuditSegment[];
}

function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "In progress";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

function groupingLabel(g: Grouping): string {
  switch (g.kind) {
    case "completed":
      return `Completed row (${g.groupSegmentCount} segment${g.groupSegmentCount === 1 ? "" : "s"}, ${formatDuration(g.groupDurationSeconds)} combined)`;
    case "unresolved":
      return g.ambiguous
        ? `Unresolved — AMBIGUOUS (${g.candidatesInCycle} candidates in this work cycle)`
        : `Unresolved — unambiguous (${g.groupSegmentCount} segment${g.groupSegmentCount === 1 ? "" : "s"}, ${formatDuration(g.groupDurationSeconds)} combined)`;
    case "in-progress":
      return "In progress";
    case "not-density-eligible":
      return "Not density-eligible";
  }
}

function defaultDateRange(): { start: string; end: string } {
  const start = startOfWeekMonday(todayInAppTimezone());
  return { start, end: addCalendarDays(start, 6) };
}

// A read-only diagnostic tool (Administrator/Manager) — investigates exactly
// why an Activity Report's Average Speed does or doesn't count a given
// segment's quantity, for one employee/activity/date range, by calling the
// SAME resolution logic getActivityReportData uses (see server/src/lib/
// reportQueries.ts's getActivityDensityAudit). Not itself a saved report and
// never edits anything — purely a "show your work" view for tracing a
// reported discrepancy back to a specific row/segment/cycle.
export function ReportDensityAuditPage() {
  const navigate = useNavigate();
  const [activities, setActivities] = useState<ActivityOption[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[] | null>(null);
  const [activityId, setActivityId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [range, setRange] = useState(defaultDateRange());
  const [result, setResult] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ activities: ActivityOption[] }>("/api/activities?status=active")
      .then((res) => setActivities(res.activities))
      .catch(() => setActivities([]));
    api<{ employees: EmployeeOption[] }>("/api/employees")
      .then((res) => setEmployees(res.employees))
      .catch(() => setEmployees([]));
  }, []);

  async function runAudit() {
    if (!activityId || !employeeId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({ activityId, employeeId, start: range.start, end: range.end });
      const res = await api<AuditResponse>(`/api/reports/audit/density-attribution?${params.toString()}`);
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not run the audit");
    } finally {
      setLoading(false);
    }
  }

  const includedCount = result?.segments.filter((s) => s.includedInReport).length ?? 0;
  const includedQuantity = result?.segments.reduce((sum, s) => sum + (s.includedInReport ? s.attributedQuantity ?? 0 : 0), 0) ?? 0;

  return (
    <section className="employees-page report-density-audit">
      <div className="employees-toolbar">
        <button type="button" onClick={() => navigate("/reports")} className="report-back-button">
          ← Reports
        </button>
        <h1>Production Audit</h1>
      </div>
      <p className="report-view-meta">
        Read-only diagnostic — shows, per raw work segment, exactly why the Activity Report's quantity/speed attribution does or doesn't
        include it.
      </p>

      <div className="report-density-audit-form">
        <label>
          Activity
          <select value={activityId} onChange={(e) => setActivityId(e.target.value)}>
            <option value="">Select an activity...</option>
            {activities?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Employee
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Select an employee...</option>
            {employees?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.firstName} {e.lastName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Start date
          <input type="date" value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
        </label>
        <label>
          End date
          <input type="date" value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
        </label>
        <button type="button" className="employee-form-save" disabled={!activityId || !employeeId || loading} onClick={runAudit}>
          {loading ? "Running..." : "Run audit"}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {result && (
        <>
          <p className="report-view-meta">
            {result.employee.firstName} {result.employee.lastName} · {result.activity.name} · {range.start} – {range.end} ·{" "}
            {includedCount} of {result.segments.length} segments included · {includedQuantity.toFixed(1)} total attributed quantity
          </p>
          <div className="report-pivot-wrap">
            <table className="employees-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Date</th>
                  <th>Start</th>
                  <th>End</th>
                  <th className="report-col-right">Duration</th>
                  <th>Density</th>
                  <th>Completion grouping</th>
                  <th className="report-col-right">Attributed qty</th>
                  <th>Included?</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {result.segments.map((s) => (
                  <tr key={s.segmentId}>
                    <td>{s.rowLabel}</td>
                    <td>{s.date}</td>
                    <td>{formatTime(s.startedAt)}</td>
                    <td>{formatTime(s.endedAt)}</td>
                    <td className="report-col-right">{formatDuration(s.durationSeconds)}</td>
                    <td>{s.densityType ? `${s.densityCountPerRow ?? "—"} ${s.densityType}` : "—"}</td>
                    <td>{groupingLabel(s.completionGrouping)}</td>
                    <td className="report-col-right">{s.attributedQuantity ?? "—"}</td>
                    <td>{s.includedInReport ? "Yes" : "No"}</td>
                    <td>{s.exclusionReason ?? ""}</td>
                  </tr>
                ))}
                {result.segments.length === 0 && (
                  <tr>
                    <td colSpan={10} className="placeholder-page">
                      No work segments for this employee/activity in this date range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
