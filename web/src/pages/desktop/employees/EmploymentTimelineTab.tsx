import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { useAuth } from "../../../context/AuthContext";
import { todayInAppTimezone } from "../../../lib/timezone";
import { getTimelineColumns, filterEmploymentTimelineEmployees, shiftAnchor, TimelineViewType, TimelineColumn } from "../../../lib/employmentTimeline";
import { enumerateDates } from "../../../lib/timezone";
import { EmploymentTimelineEmployee, EmploymentPeriod, EMPTY_FILTER_STATE, EmploymentTimelineFilterState } from "../../../lib/employmentPeriodTypes";
import { EmploymentTimelineGraph } from "../../../components/employees/EmploymentTimelineGraph";
import { EmploymentTimelineTable } from "../../../components/employees/EmploymentTimelineTable";
import { EmploymentTimelineFilters } from "../../../components/employees/EmploymentTimelineFilters";
import { EmploymentPeriodModal } from "../../../components/employees/EmploymentPeriodModal";
import { exportEmploymentTimelineCsv, exportEmploymentTimelinePdf, printEmploymentTimeline } from "../../../lib/employmentTimelineExport";

type ViewMode = "graph" | "table";

interface ModalState {
  employee: EmploymentTimelineEmployee;
  period: EmploymentPeriod | null; // null = adding a new period
}

export function EmploymentTimelineTab() {
  const { employee: currentEmployee } = useAuth();
  const canEdit = currentEmployee?.securityRole === "Administrator";

  const [employees, setEmployees] = useState<EmploymentTimelineEmployee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<EmploymentTimelineFilterState>(EMPTY_FILTER_STATE);
  const [view, setView] = useState<TimelineViewType>("month");
  const [anchorDate, setAnchorDate] = useState(todayInAppTimezone());
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [modalState, setModalState] = useState<ModalState | null>(null);
  const [rangeOverride, setRangeOverride] = useState<{ start: string; end: string } | null>(null);

  const load = useCallback(() => {
    api<{ employees: EmploymentTimelineEmployee[] }>("/api/employment-periods")
      .then((res) => {
        setEmployees(res.employees);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load employment timeline"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const today = todayInAppTimezone();

  const columns = useMemo<TimelineColumn[]>(() => {
    if (rangeOverride && rangeOverride.start && rangeOverride.end && rangeOverride.start <= rangeOverride.end) {
      // A custom date-range override renders at day granularity (Month-view
      // style columns) spanning exactly the chosen range, overriding
      // Prev/Next navigation entirely, per the brief's "date-range
      // selection" requirement.
      return enumerateDates(rangeOverride.start, rangeOverride.end).map((d) => ({
        key: d,
        label: String(Number(d.slice(8, 10))),
        startDate: d,
        endDate: d,
      }));
    }
    return getTimelineColumns(view, anchorDate);
  }, [view, anchorDate, rangeOverride]);

  const filteredEmployees = useMemo(() => (employees ? filterEmploymentTimelineEmployees(employees, filters) : []), [employees, filters]);

  function handlePrev() {
    setRangeOverride(null);
    setAnchorDate((prev) => shiftAnchor(view, prev, -1));
  }
  function handleNext() {
    setRangeOverride(null);
    setAnchorDate((prev) => shiftAnchor(view, prev, 1));
  }
  function handleToday() {
    setRangeOverride(null);
    setAnchorDate(todayInAppTimezone());
  }

  function handleModalSaved() {
    setModalState(null);
    load();
  }

  const employeeOptions = useMemo(() => (employees ?? []).map((e) => ({ id: e.id, firstName: e.firstName, lastName: e.lastName })), [employees]);

  return (
    <div className="employment-timeline-view">
      <div className="employment-timeline-toolbar">
        <div className="employment-timeline-view-switch">
          <button type="button" className={view === "month" && !rangeOverride ? "active" : ""} onClick={() => { setRangeOverride(null); setView("month"); }}>
            Month
          </button>
          <button type="button" className={view === "quarter" && !rangeOverride ? "active" : ""} onClick={() => { setRangeOverride(null); setView("quarter"); }}>
            Quarter
          </button>
          <button type="button" className={view === "year" && !rangeOverride ? "active" : ""} onClick={() => { setRangeOverride(null); setView("year"); }}>
            Year
          </button>
        </div>

        <div className="employment-timeline-nav">
          <button type="button" onClick={handlePrev} disabled={!!rangeOverride} aria-label="Previous">
            ‹
          </button>
          <button type="button" onClick={handleToday}>
            Today
          </button>
          <button type="button" onClick={handleNext} disabled={!!rangeOverride} aria-label="Next">
            ›
          </button>
        </div>

        <div className="employment-timeline-range-picker">
          <label>
            From
            <input
              type="date"
              value={rangeOverride?.start ?? ""}
              onChange={(e) => setRangeOverride((prev) => ({ start: e.target.value, end: prev?.end ?? e.target.value }))}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={rangeOverride?.end ?? ""}
              onChange={(e) => setRangeOverride((prev) => ({ start: prev?.start ?? e.target.value, end: e.target.value }))}
            />
          </label>
        </div>

        <div className="employment-timeline-view-mode">
          <button type="button" className={viewMode === "graph" ? "active" : ""} onClick={() => setViewMode("graph")}>
            Graph
          </button>
          <button type="button" className={viewMode === "table" ? "active" : ""} onClick={() => setViewMode("table")}>
            Table
          </button>
        </div>

        <div className="employment-timeline-export-actions">
          <button type="button" onClick={() => exportEmploymentTimelineCsv(filteredEmployees)}>
            Export CSV
          </button>
          <button type="button" onClick={() => exportEmploymentTimelinePdf(filteredEmployees)}>
            Export PDF
          </button>
          <button
            type="button"
            onClick={() => {
              // The graph itself isn't print-friendly (a wide, horizontally
              // scrolled Gantt chart) — printing always renders the
              // accessible table view, so switch to it first if the user is
              // currently looking at the graph.
              setViewMode("table");
              window.requestAnimationFrame(() => printEmploymentTimeline("landscape"));
            }}
          >
            Print
          </button>
        </div>
      </div>

      <EmploymentTimelineFilters filters={filters} onChange={setFilters} employees={employeeOptions} />

      {error && <p className="error-text">{error}</p>}

      {!employees ? (
        <p>Loading...</p>
      ) : filteredEmployees.length === 0 ? (
        <p className="placeholder-page">No employees match the current filters.</p>
      ) : viewMode === "graph" ? (
        <EmploymentTimelineGraph
          employees={filteredEmployees}
          columns={columns}
          today={today}
          canEdit={canEdit}
          onBarClick={(employee, period) => setModalState({ employee, period })}
          onAddPeriod={(employee) => setModalState({ employee, period: null })}
        />
      ) : (
        <EmploymentTimelineTable employees={filteredEmployees} />
      )}

      {modalState && (
        <EmploymentPeriodModal
          employeeId={modalState.employee.id}
          employeeName={`${modalState.employee.firstName} ${modalState.employee.lastName}`}
          period={modalState.period}
          readOnly={!canEdit}
          onClose={() => setModalState(null)}
          onSaved={handleModalSaved}
        />
      )}
    </div>
  );
}
