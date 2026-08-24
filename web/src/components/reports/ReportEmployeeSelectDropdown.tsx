import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { EmployeeSelectionMode } from "../../lib/reportTypes";

export interface ReportEmployeeOption {
  id: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

interface ReportEmployeeSelectDropdownProps {
  employees: ReportEmployeeOption[] | null;
  committedMode: EmployeeSelectionMode;
  committedIds: string[];
  // Persists the staged selection to the report's server-side definition
  // (PATCH /api/reports/:id) — throwing surfaces as this component's own
  // inline error, matching the pattern of every other save-in-place control
  // on this page (see ReportViewPage.tsx's saveMetrics).
  onSave: (mode: EmployeeSelectionMode, ids: string[]) => Promise<void>;
}

// Compact, anchored multi-select — replaces the old always-expanded
// "Employees" grid (ReportViewPage.tsx's former report-employee-filter-bar
// section, which pushed the whole report down the page). Renders as a
// single trigger button; the checklist itself is a position:absolute panel
// anchored to it (index.css's .report-employee-select-panel), so opening it
// never reflows anything below.
//
// Selection is staged locally (stagedMode/stagedIds) and only reaches the
// server when Save is pressed — closing via Cancel, Escape, or an outside
// click discards the staged copy and reverts to whatever was last actually
// saved (committedMode/committedIds), never partially applying an in-
// progress edit.
export function ReportEmployeeSelectDropdown({ employees, committedMode, committedIds, onSave }: ReportEmployeeSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const [stagedMode, setStagedMode] = useState<EmployeeSelectionMode>(committedMode);
  const [stagedIds, setStagedIds] = useState<Set<string>>(new Set(committedIds));
  const [search, setSearch] = useState("");
  // Picker-visibility only, never persisted — an inactive employee already
  // in stagedIds always stays visible/checked regardless of this toggle
  // (see visibleEmployees below), so a historical selection can never be
  // silently hidden away from view, only newly ADDING an inactive employee
  // to the selection requires opting in.
  const [includeInactive, setIncludeInactive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  function resetStagedToCommitted() {
    setStagedMode(committedMode);
    setStagedIds(new Set(committedIds));
    setSearch("");
    setIncludeInactive(false);
    setError(null);
  }

  function openPanel() {
    resetStagedToCommitted();
    setOpen(true);
  }

  function cancel() {
    setOpen(false);
    resetStagedToCommitted();
  }

  // Outside-click and Escape close without saving — same intent as
  // components/ui/Modal.tsx's Escape handler, plus a mousedown listener
  // (nothing else in this app needs one, since Modal already gets a true
  // full-viewport backdrop to click for free) since this panel is a small
  // anchored overlay, not a backdrop-covered modal.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
    }
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) cancel();
    }
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, committedMode, committedIds.join(",")]);

  const searchTerm = search.trim().toLowerCase();
  const visibleEmployees = useMemo(() => {
    const list = employees ?? [];
    return list.filter((employee) => {
      const matchesSearch = !searchTerm || `${employee.firstName} ${employee.lastName}`.toLowerCase().includes(searchTerm);
      if (!matchesSearch) return false;
      // Always show an employee already staged, active or not — see the
      // includeInactive comment above.
      return employee.isActive || includeInactive || stagedIds.has(employee.id);
    });
  }, [employees, searchTerm, includeInactive, stagedIds]);

  function toggleEmployee(id: string) {
    setStagedMode("selected");
    setStagedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setStagedMode("selected");
    setStagedIds((prev) => new Set([...prev, ...visibleEmployees.map((e) => e.id)]));
  }

  function clearAll() {
    setStagedMode("selected");
    setStagedIds(new Set());
  }

  async function handleSave() {
    if (stagedMode === "selected" && stagedIds.size === 0) {
      setError("Select at least one employee, or switch to All employees.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(stagedMode, stagedMode === "all" ? [] : [...stagedIds]);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save employee selection");
    } finally {
      setSaving(false);
    }
  }

  const triggerCount = open ? stagedIds.size : committedIds.length;
  const triggerMode = open ? stagedMode : committedMode;
  const triggerLabel = triggerMode === "all" ? "All employees" : `${triggerCount} employee${triggerCount === 1 ? "" : "s"} selected`;

  return (
    <div className="report-employee-select" ref={rootRef}>
      <button
        type="button"
        className="report-employee-select-trigger"
        onClick={() => (open ? cancel() : openPanel())}
        aria-expanded={open}
      >
        {triggerLabel} <span aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>
      <button
        type="button"
        className="report-employee-select-save"
        onClick={handleSave}
        disabled={!open || saving || (stagedMode === "selected" && stagedIds.size === 0)}
      >
        {saving ? "Saving..." : "Save"}
      </button>

      {open && (
        <div className="report-employee-select-panel" role="dialog" aria-label="Select employees">
          <div className="report-employee-select-mode">
            <label>
              <input type="radio" checked={stagedMode === "all"} onChange={() => setStagedMode("all")} />
              All employees
            </label>
            <label>
              <input type="radio" checked={stagedMode === "selected"} onChange={() => setStagedMode("selected")} />
              Select specific employees
            </label>
          </div>

          {stagedMode === "selected" && (
            <>
              <div className="report-employee-select-toolbar">
                <input
                  type="text"
                  className="report-employee-search"
                  placeholder="Search employees..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="report-employee-filter-actions">
                  <button type="button" onClick={selectAllVisible} disabled={visibleEmployees.length === 0}>
                    Select all
                  </button>
                  <button type="button" onClick={clearAll} disabled={stagedIds.size === 0}>
                    Clear
                  </button>
                </div>
              </div>

              <label className="report-employee-include-inactive">
                <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
                Include inactive employees
              </label>

              <div className="report-employee-select-list">
                {!employees ? (
                  <p className="placeholder-page">Loading employees...</p>
                ) : visibleEmployees.length === 0 ? (
                  <p className="placeholder-page">No employees match.</p>
                ) : (
                  visibleEmployees.map((employee) => (
                    <label key={employee.id} className="report-employee-filter-item">
                      <input type="checkbox" checked={stagedIds.has(employee.id)} onChange={() => toggleEmployee(employee.id)} />
                      <span>
                        {employee.firstName} {employee.lastName}
                      </span>
                      {!employee.isActive && <span className="report-employee-inactive">Inactive</span>}
                    </label>
                  ))
                )}
              </div>
            </>
          )}

          {error && <p className="error-text">{error}</p>}

          <div className="report-employee-select-footer">
            <button type="button" onClick={cancel} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
