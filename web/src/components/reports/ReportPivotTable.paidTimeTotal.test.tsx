// @vitest-environment jsdom
//
// Proves the "Total Paid Time" column's ON-SCREEN rendering contract:
// present (header + one cell per employee + a combined DAY TOTAL-row cell)
// exactly when grid.totalPaidTimeGrandTotal is set, entirely absent
// otherwise — the same single source of truth CSV/PDF export read from
// (reportExport.paidTimeTotal.test.ts), so the three surfaces can never
// disagree about whether the column should appear.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReportPivotTable } from "./ReportPivotTable";
import { PivotGrid } from "../../lib/reportPivot";

// Explicit rather than relying on auto-registration — this project's
// vitest config doesn't set test.globals: true, so each render() would
// otherwise accumulate in the document across tests in this file (several
// share literal text like "Total Paid Time" and "DAY TOTAL").
afterEach(() => {
  cleanup();
});

describe("ReportPivotTable — Total Paid Time column", () => {
  it("renders the column (header, per-employee cell, and combined DAY TOTAL cell) when the grid has totalPaidTime values", () => {
    const grid: PivotGrid = {
      dates: ["2026-08-17"],
      employees: [
        { employeeId: "e1", employeeName: "Alice", cells: ["50.0 plants/hour"], grandTotal: "48.0 plants/hour", totalPaidTime: "4:30" },
        { employeeId: "e2", employeeName: "Bob", cells: ["40.0 plants/hour"], grandTotal: "39.5 plants/hour", totalPaidTime: "2:00" },
      ],
      columnTotals: ["45.0 plants/hour"],
      grandTotal: "44.0 plants/hour",
      totalPaidTimeGrandTotal: "6:30",
    };
    render(<ReportPivotTable grid={grid} />);

    expect(screen.getByText("Total Paid Time")).toBeInTheDocument();
    expect(screen.getByText("4:30")).toBeInTheDocument();
    expect(screen.getByText("2:00")).toBeInTheDocument();
    // The bottom row's own leading label ("DAY TOTAL") already establishes
    // this cell is a combined total, not a per-employee average.
    expect(screen.getByText("DAY TOTAL")).toBeInTheDocument();
    expect(screen.getByText("6:30")).toBeInTheDocument();

    // Employee Total is unaffected — still shows the currently-selected
    // metric's own value (Average Speed here), independent of Paid time.
    expect(screen.getByText("48.0 pl/hr")).toBeInTheDocument();
    expect(screen.getByText("39.5 pl/hr")).toBeInTheDocument();
  });

  it("hides the column entirely when the grid has no totalPaidTime values (Paid time unchecked)", () => {
    const grid: PivotGrid = {
      dates: ["2026-08-17"],
      employees: [{ employeeId: "e1", employeeName: "Alice", cells: ["10:25"], grandTotal: "10:25" }],
      columnTotals: ["10:25"],
      grandTotal: "10:25",
    };
    render(<ReportPivotTable grid={grid} />);
    expect(screen.queryByText("Total Paid Time")).not.toBeInTheDocument();
  });

  it("stays visible even when the Show metric is something else entirely (e.g. rows completed), never tied to the selected metric", () => {
    const grid: PivotGrid = {
      dates: ["2026-08-18"],
      employees: [{ employeeId: "e1", employeeName: "Alice", cells: ["3"], grandTotal: "5", totalPaidTime: "8:00" }],
      columnTotals: ["3"],
      grandTotal: "5",
      totalPaidTimeGrandTotal: "8:15",
    };
    render(<ReportPivotTable grid={grid} />);
    expect(screen.getByText("Total Paid Time")).toBeInTheDocument();
    expect(screen.getByText("8:00")).toBeInTheDocument(); // per-employee cell
    expect(screen.getByText("8:15")).toBeInTheDocument(); // combined DAY TOTAL cell — deliberately different, proving each is its own value
    // "5" (rows-completed grand total, shown twice here — the single
    // employee's own Employee Total and the bottom-right grand total
    // naturally coincide with only one employee) is unrelated to and
    // unaffected by the paid-time column's own presence.
    expect(screen.getAllByText("5").length).toBe(2);
  });

  it("falls back to a dash for an employee somehow missing totalPaidTime while the grid overall has the column enabled", () => {
    const grid: PivotGrid = {
      dates: ["2026-08-19"],
      employees: [{ employeeId: "e1", employeeName: "Alice", cells: ["1:00"], grandTotal: "1:00" }],
      columnTotals: ["1:00"],
      grandTotal: "1:00",
      totalPaidTimeGrandTotal: "0:45",
    };
    render(<ReportPivotTable grid={grid} />);
    expect(screen.getByText("Total Paid Time")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
