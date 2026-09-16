import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { useAuth } from "../../../context/AuthContext";
import { todayInAppTimezone } from "../../../lib/timezone";
import { computeFittedRange, filterEmploymentTimelineEmployees, TimelineRange } from "../../../lib/employmentTimeline";
import { EmploymentTimelineEmployee, EmploymentPeriod, EMPTY_FILTER_STATE, EmploymentTimelineFilterState } from "../../../lib/employmentPeriodTypes";
import { EmploymentTimelineGraph } from "../../../components/employees/EmploymentTimelineGraph";
import { EmploymentTimelineTable } from "../../../components/employees/EmploymentTimelineTable";
import { EmploymentTimelineFilters } from "../../../components/employees/EmploymentTimelineFilters";
import { EmploymentPeriodModal } from "../../../components/employees/EmploymentPeriodModal";
import { exportEmploymentTimelineCsv, exportEmploymentTimelinePdf, printEmploymentTimeline } from "../../../lib/employmentTimelineExport";
import { DownloadIcon, PrintIcon } from "../../../components/ui/icons";

type ViewMode = "graph" | "table";

interface ModalState {
  employee: EmploymentTimelineEmployee;
  period: EmploymentPeriod | null; // null = adding a new period
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1;

export function EmploymentTimelineTab() {
  const { employee: currentEmployee } = useAuth();
  const canEdit = currentEmployee?.securityRole === "Administrator";

  const [employees, setEmployees] = useState<EmploymentTimelineEmployee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<EmploymentTimelineFilterState>(EMPTY_FILTER_STATE);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [modalState, setModalState] = useState<ModalState | null>(null);
  // Optional manual override of the default "Fit all" range — unrelated to
  // zoom (which just changes pixel density within whatever range is shown).
  const [rangeOverride, setRangeOverride] = useState<{ start: string; end: string } | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [scrollToTodayToken, setScrollToTodayToken] = useState(0);

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

  const filteredEmployees = useMemo(() => (employees ? filterEmploymentTimelineEmployees(employees, filters) : []), [employees, filters]);

  // The default, primary view: fits the complete range of every currently
  // visible (already filtered) employee — recalculated automatically
  // whenever the filters change, simply by depending on filteredEmployees.
  // A valid custom From/To override takes precedence when set.
  const fittedRange = useMemo(() => computeFittedRange(filteredEmployees, today), [filteredEmployees, today]);
  const range: TimelineRange | null =
    rangeOverride && rangeOverride.start && rangeOverride.end && rangeOverride.start <= rangeOverride.end ? (rangeOverride as TimelineRange) : fittedRange;

  function handleFitAll() {
    setRangeOverride(null);
    setZoom(MIN_ZOOM);
  }
  function handleToday() {
    setScrollToTodayToken((t) => t + 1);
  }
  function handleZoomIn() {
    setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
  }
  function handleZoomOut() {
    setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP));
  }

  function handleModalSaved() {
    setModalState(null);
    load();
  }

  const employeeOptions = useMemo(() => (employees ?? []).map((e) => ({ id: e.id, firstName: e.firstName, lastName: e.lastName })), [employees]);

  return (
    <div className="employment-timeline-view">
      <div className="employment-timeline-toolbar">
        <div className="employment-timeline-nav">
          <button type="button" className="employment-timeline-fit-all" onClick={handleFitAll} aria-pressed={!rangeOverride && zoom === MIN_ZOOM}>
            Full timeline
          </button>
          <button type="button" className="employment-timeline-nav-today" onClick={handleToday}>
            Today
          </button>
        </div>

        <div className="employment-timeline-zoom" role="group" aria-label="Zoom">
          <button type="button" className="employment-timeline-nav-arrow" onClick={handleZoomOut} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out">
            −
          </button>
          <span className="employment-timeline-zoom-label">Zoom</span>
          <button type="button" className="employment-timeline-nav-arrow" onClick={handleZoomIn} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in">
            +
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

        <div className="employment-timeline-view-mode" role="group" aria-label="View mode">
          <button type="button" className={viewMode === "graph" ? "active" : ""} aria-pressed={viewMode === "graph"} onClick={() => setViewMode("graph")}>
            Graph
          </button>
          <button type="button" className={viewMode === "table" ? "active" : ""} aria-pressed={viewMode === "table"} onClick={() => setViewMode("table")}>
            Table
          </button>
        </div>

        <div className="employment-timeline-export-actions">
          <button type="button" onClick={() => exportEmploymentTimelineCsv(filteredEmployees)}>
            <DownloadIcon /> Export CSV
          </button>
          <button type="button" onClick={() => exportEmploymentTimelinePdf(filteredEmployees)}>
            <DownloadIcon /> Export PDF
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
            <PrintIcon /> Print
          </button>
        </div>
      </div>

      <EmploymentTimelineFilters filters={filters} onChange={setFilters} employees={employeeOptions} />

      {error && <p className="error-text">{error}</p>}

      {!employees ? (
        <p>Loading...</p>
      ) : filteredEmployees.length === 0 ? (
        <p className="placeholder-page">No employees match the current filters.</p>
      ) : !range ? (
        <p className="placeholder-page">No employment dates recorded for any visible employee.</p>
      ) : viewMode === "graph" ? (
        <EmploymentTimelineGraph
          employees={filteredEmployees}
          range={range}
          today={today}
          zoom={zoom}
          canEdit={canEdit}
          scrollToTodayToken={scrollToTodayToken}
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
