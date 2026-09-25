// @vitest-environment jsdom
//
// Proves ReportPivotTable's on-screen rendering contract for the two
// mutually-exclusive trailing-column layouts, discriminated purely by
// grid.weeklyTotalColumns's presence (never by an explicit "report type"
// prop — this component stays a pure PivotGrid consumer):
//   - Activity: grid.weeklyTotalColumns present -> N columns (one per
//     entry, in order), values from row.weeklyTotals/
//     grid.weeklyTotalColumnTotals. No "Employee Total" column at all.
//   - Payroll: grid.weeklyTotalColumns absent -> the original single
//     "Employee Total" column (row.grandTotal/grid.grandTotal).
// The same PivotGrid shape CSV/PDF export read from
// (reportExport.weeklyTotals.test.ts), so all three surfaces can never
// disagree about which columns appear or what they show.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReportPivotTable } from "./ReportPivotTable";
import { PivotGrid } from "../../lib/reportPivot";

// Explicit rather than relying on auto-registration — this project's
// vitest config doesn't set test.globals: true, so each render() would
// otherwise accumulate in the document across tests in this file.
afterEach(() => {
  cleanup();
});

describe("ReportPivotTable — weekly totals columns (Activity) vs Employee Total (Payroll)", () => {
  it("renders Payroll's single Employee Total column when weeklyTotalColumns is absent", () => {
    const grid: PivotGrid = {
      dates: ["2026-08-17"],
      employees: [
        { employeeId: "e1", employeeName: "Alice", cells: ["50.0 plants/hour"], grandTotal: "48.0 plants/hour" },
        { employeeId: "e2", employeeName: "Bob", cells: ["40.0 plants/hour"], grandTotal: "39.5 plants/hour" },
      ],
      columnTotals: ["45.0 plants/hour"],
      grandTotal: "44.0 plants/hour",
    };
    render(<ReportPivotTable grid={grid} />);

    expect(screen.getByText("Employee Total")).toBeInTheDocument();
    expect(screen.getByText("48.0 pl/hr")).toBeInTheDocument();
    expect(screen.getByText("39.5 pl/hr")).toBeInTheDocument();
    expect(screen.getByText("44.0 pl/hr")).toBeInTheDocument();
    expect(screen.queryByText("Employee Paid Time")).not.toBeInTheDocument();
  });

  it("renders N Activity weekly-total columns (header, per-employee cells, combined DAY TOTAL cells), never an Employee Total column", () => {
    const grid: PivotGrid = {
      dates: ["2026-08-17"],
      employees: [
        { employeeId: "e1", employeeName: "Alice", cells: ["50.0 plants/hour"], weeklyTotals: ["6:45", "4:30"] },
        { employeeId: "e2", employeeName: "Bob", cells: ["40.0 plants/hour"], weeklyTotals: ["2:00", "2:15"] },
      ],
      columnTotals: ["45.0 plants/hour"],
      weeklyTotalColumns: [
        { key: "activityHours", label: "Weekly Activity Hours" },
        { key: "employeePaidTime", label: "Employee Paid Time" },
      ],
      weeklyTotalColumnTotals: ["8:45", "6:45"],
    };
    render(<ReportPivotTable grid={grid} />);

    expect(screen.getByText("Weekly Activity Hours")).toBeInTheDocument();
    expect(screen.getByText("Employee Paid Time")).toBeInTheDocument();
    expect(screen.getByText("4:30")).toBeInTheDocument();
    expect(screen.getByText("2:00")).toBeInTheDocument();
    expect(screen.getByText("2:15")).toBeInTheDocument();
    expect(screen.getByText("8:45")).toBeInTheDocument();
    // "6:45" appears twice — Alice's own first weekly total AND the bottom
    // row's combined second-column total (8:45 activity hours / 6:45 paid
    // time) — coincidentally the same text, distinct cells; proves each is
    // its own value rather than the columns bleeding into each other.
    expect(screen.getAllByText("6:45").length).toBe(2);
    expect(screen.queryByText("Employee Total")).not.toBeInTheDocument();
  });

  it("falls back to a dash for an employee somehow missing a weeklyTotals entry while the grid overall has that column", () => {
    const grid: PivotGrid = {
      dates: ["2026-08-19"],
      employees: [{ employeeId: "e1", employeeName: "Alice", cells: ["1:00"] }],
      columnTotals: ["1:00"],
      weeklyTotalColumns: [{ key: "activityHours", label: "Weekly Activity Hours" }],
      weeklyTotalColumnTotals: ["0:45"],
    };
    render(<ReportPivotTable grid={grid} />);
    expect(screen.getByText("Weekly Activity Hours")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("0:45")).toBeInTheDocument();
  });
});
