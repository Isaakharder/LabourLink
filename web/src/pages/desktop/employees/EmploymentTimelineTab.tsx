import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { useAuth } from "../../../context/AuthContext";
import { todayInAppTimezone } from "../../../lib/timezone";
import { computeFittedRange, filterEmploymentTimelineEmployees, TimelineRange } from "../../../lib/employmentTimeline";
import { EmploymentTimelineEmployee, EmploymentPeriod, EMPTY_FILTER_STATE, EmploymentTimelineFilterState } from "../../../lib/employmentPeriodTypes";
import { EmploymentTimelineGraph, EmploymentTimelineGraphHandle } from "../../../components/employees/EmploymentTimelineGraph";
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

interface DisplayStartResponse {
  displayStart: string | null;
}

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
  // Clearing this returns to the saved "Timeline starts" setting, not to
  // the raw earliest employee start — see the fittedRange memo below.
  const [rangeOverride, setRangeOverride] = useState<{ start: string; end: string } | null>(null);
  const [scrollToTodayToken, setScrollToTodayToken] = useState(0);
  const graphRef = useRef<EmploymentTimelineGraphHandle>(null);
  const [canZoomIn, setCanZoomIn] = useState(true);
  const [canZoomOut, setCanZoomOut] = useState(false);

  // -- "Timeline starts" org setting ------------------------------------
  // Administrator-only saved display cutoff (org_settings.employment_timeline_display_start,
  // migration 053) — a display-only preference, never a change to any
  // employee's real start_date. null = no saved cutoff, fall back to the
  // earliest real start date among currently-included employees.
  const [savedDisplayStart, setSavedDisplayStart] = useState<string | null>(null);
  const [displayStartDraft, setDisplayStartDraft] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const loadDisplayStart = useCallback(() => {
    api<DisplayStartResponse>("/api/employment-periods/settings/display-start")
      .then((res) => {
        setSavedDisplayStart(res.displayStart);
        setDisplayStartDraft(res.displayStart ?? "");
      })
      .catch(() => {
        // Non-fatal — the graph still works fine falling back to the
        // earliest employee start; this setting is a display convenience.
      });
  }, []);

  useEffect(() => {
    loadDisplayStart();
  }, [loadDisplayStart]);

  async function handleSaveDisplayStart() {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const res = await api<DisplayStartResponse>("/api/employment-periods/settings/display-start", {
        method: "PATCH",
        body: JSON.stringify({ displayStart: displayStartDraft || null }),
      });
      setSavedDisplayStart(res.displayStart);
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : "Could not save the Timeline starts setting");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleResetDisplayStart() {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const res = await api<DisplayStartResponse>("/api/employment-periods/settings/display-start", {
        method: "PATCH",
        body: JSON.stringify({ displayStart: null }),
      });
      setSavedDisplayStart(res.displayStart);
      setDisplayStartDraft("");
    } catch (err) {
      setSettingsError(err instanceof ApiError ? err.message : "Could not reset the Timeline starts setting");
    } finally {
      setSettingsSaving(false);
    }
  }

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
  // visible (already filtered) employee, left-bounded by the saved
  // "Timeline starts" setting when one is on file — recalculated
  // automatically whenever the filters (or the saved setting) change,
  // simply by depending on them. A valid custom From/To override takes
  // precedence when set; clearing it falls back to this, never to the raw
  // unbounded earliest start.
  const fittedRange = useMemo(
    () => computeFittedRange(filteredEmployees, today, savedDisplayStart),
    [filteredEmployees, today, savedDisplayStart]
  );
  const range: TimelineRange | null =
    rangeOverride && rangeOverride.start && rangeOverride.end && rangeOverride.start <= rangeOverride.end ? (rangeOverride as TimelineRange) : fittedRange;

  function handleFitAll() {
    setRangeOverride(null);
    graphRef.current?.fitAll();
  }
  function handleToday() {
    setScrollToTodayToken((t) => t + 1);
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
          <button type="button" className="employment-timeline-fit-all" onClick={handleFitAll}>
            Full timeline
          </button>
          <button type="button" className="employment-timeline-nav-today" onClick={handleToday}>
            Today
          </button>
        </div>

        <div className="employment-timeline-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="employment-timeline-nav-arrow"
            onClick={() => graphRef.current?.zoomOut()}
            disabled={!canZoomOut}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="employment-timeline-zoom-label">Zoom</span>
          <button
            type="button"
            className="employment-timeline-nav-arrow"
            onClick={() => graphRef.current?.zoomIn()}
            disabled={!canZoomIn}
            aria-label="Zoom in"
          >
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

      <div className="employment-timeline-display-start">
        <label>
          Timeline starts
          <input
            type="date"
            value={displayStartDraft}
            onChange={(e) => setDisplayStartDraft(e.target.value)}
            disabled={!canEdit || settingsSaving}
          />
        </label>
        {canEdit && (
          <>
            <button type="button" onClick={handleSaveDisplayStart} disabled={settingsSaving || displayStartDraft === (savedDisplayStart ?? "")}>
              {settingsSaving ? "Saving..." : "Save"}
            </button>
            <button type="button" onClick={handleResetDisplayStart} disabled={settingsSaving || savedDisplayStart === null}>
              Reset to earliest employee start
            </button>
          </>
        )}
        {!canEdit && <span className="employment-timeline-display-start-note">Only an Administrator can change this.</span>}
        {settingsError && <span className="field-error">{settingsError}</span>}
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
          ref={graphRef}
          employees={filteredEmployees}
          range={range}
          today={today}
          canEdit={canEdit}
          scrollToTodayToken={scrollToTodayToken}
          onZoomLimitsChange={(zoomIn, zoomOut) => {
            setCanZoomIn(zoomIn);
            setCanZoomOut(zoomOut);
          }}
          onBarClick={(employee, period) => setModalState({ employee, period })}
          onAddPeriod={(employee) => setModalState({ employee, period: null })}
        />
      ) : (
        <EmploymentTimelineTable employees={filteredEmployees} />
      )}

      {modalState && (
        <EmploymentPeriodModal
          // Forces a remount (and fresh form state) when switching from
          // editing one period to "Add another period" for the same
          // employee — same component type, different `period` prop, which
          // React would otherwise keep the existing form state for.
          key={modalState.period?.id ?? `new-${modalState.employee.id}`}
          employeeId={modalState.employee.id}
          employeeName={`${modalState.employee.firstName} ${modalState.employee.lastName}`}
          period={modalState.period}
          readOnly={!canEdit}
          onClose={() => setModalState(null)}
          onSaved={handleModalSaved}
          onAddAnother={() => setModalState({ employee: modalState.employee, period: null })}
        />
      )}
    </div>
  );
}
