// Display-only ordering of a PivotGrid's employee rows. The grid builders
// (reportPivot.ts) always emit employees in the existing alphabetical
// order; this only ever REORDERS those rows — it never rebuilds, refetches,
// or touches any cell/total value — so the on-screen table, Print, the
// Print/PDF preview, CSV, and PDF (which all read the same PivotGrid) share
// one order. The DAY TOTAL row lives on the grid itself (columnTotals etc.),
// never in grid.employees, so it can't be mixed into the sort and every
// output keeps rendering it last.
import { PivotGrid } from "./reportPivot";

export type EmployeeSortMode = "alphabetical" | "speedDesc";

export const DEFAULT_EMPLOYEE_SORT: EmployeeSortMode = "alphabetical";

export const EMPLOYEE_SORT_LABELS: Record<EmployeeSortMode, string> = {
  alphabetical: "Alphabetical",
  speedDesc: "Speed: highest first",
};

function speedKey(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Whether "Speed: highest first" means anything for this grid — false for
// Payroll (no speed at all) and for an Activity report whose activity has
// no speed metric, so callers can disable the option instead of sorting on
// missing values.
export function gridSupportsSpeedSort(grid: PivotGrid | null): boolean {
  return grid?.hasSpeedMetric === true;
}

// Falls back to alphabetical whenever speed isn't available, so a speed
// selection carried over from another report can never sort on nothing.
export function effectiveEmployeeSort(mode: EmployeeSortMode, grid: PivotGrid | null): EmployeeSortMode {
  return mode === "speedDesc" && !gridSupportsSpeedSort(grid) ? "alphabetical" : mode;
}

export function sortPivotEmployees(grid: PivotGrid, mode: EmployeeSortMode): PivotGrid {
  if (effectiveEmployeeSort(mode, grid) !== "speedDesc") return grid;
  // Array.prototype.sort is stable, and grid.employees already arrives in
  // the existing alphabetical order — so equal speeds, and every employee
  // without a speed, keep exactly that alphabetical order among themselves
  // without re-implementing the name comparison here.
  const employees = [...grid.employees].sort((a, b) => {
    const sa = speedKey(a.speedValue);
    const sb = speedKey(b.speedValue);
    if (sa === null && sb === null) return 0;
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sb - sa;
  });
  return { ...grid, employees };
}

// Kept for the lifetime of the loaded app (not persisted anywhere), so the
// choice survives moving between reports and back to the Reports list, and
// resets to alphabetical on a full reload.
let sessionEmployeeSort: EmployeeSortMode = DEFAULT_EMPLOYEE_SORT;

export function getSessionEmployeeSort(): EmployeeSortMode {
  return sessionEmployeeSort;
}

export function setSessionEmployeeSort(mode: EmployeeSortMode) {
  sessionEmployeeSort = mode;
}
