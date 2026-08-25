// @vitest-environment jsdom
//
// Proves the abbreviation is applied to EVERY Average Speed cell location
// in the pivot table: an employee/day cell, the Employee Total column, the
// DAY TOTAL row, and the bottom-right grand total — per the brief's
// explicit list of required locations.
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportPivotTable } from "./ReportPivotTable";
import { PivotGrid } from "../../lib/reportPivot";

const grid: PivotGrid = {
  dates: ["2026-08-17"],
  employees: [{ employeeId: "e1", employeeName: "Byron Escober", cells: ["51.8 stems/hour"], grandTotal: "48.0 stems/hour" }],
  columnTotals: ["45.0 stems/hour"],
  grandTotal: "46.5 stems/hour",
};

describe("ReportPivotTable — Average Speed unit abbreviation", () => {
  it("abbreviates the employee/day cell, Employee Total, DAY TOTAL, and the grand total", () => {
    render(<ReportPivotTable grid={grid} />);

    expect(screen.getByText("51.8 st/hr")).toBeInTheDocument(); // employee/day cell
    expect(screen.getByText("48.0 st/hr")).toBeInTheDocument(); // Employee Total
    expect(screen.getByText("45.0 st/hr")).toBeInTheDocument(); // DAY TOTAL row
    expect(screen.getByText("46.5 st/hr")).toBeInTheDocument(); // bottom-right grand total

    expect(screen.queryByText(/stems\/hour/)).not.toBeInTheDocument();
  });

  it("abbreviates plants/hour the same way, everywhere", () => {
    const plantsGrid: PivotGrid = {
      dates: ["2026-08-17"],
      employees: [{ employeeId: "e1", employeeName: "Byron Escober", cells: ["30.0 plants/hour"], grandTotal: "28.0 plants/hour" }],
      columnTotals: ["27.0 plants/hour"],
      grandTotal: "26.0 plants/hour",
    };
    render(<ReportPivotTable grid={plantsGrid} />);

    expect(screen.getByText("30.0 pl/hr")).toBeInTheDocument();
    expect(screen.getByText("28.0 pl/hr")).toBeInTheDocument();
    expect(screen.getByText("27.0 pl/hr")).toBeInTheDocument();
    expect(screen.getByText("26.0 pl/hr")).toBeInTheDocument();
    expect(screen.queryByText(/plants\/hour/)).not.toBeInTheDocument();
  });

  it("leaves a non-speed metric's cells (e.g. H:MM durations) completely unaffected", () => {
    const workTimeGrid: PivotGrid = {
      dates: ["2026-08-17"],
      employees: [{ employeeId: "e1", employeeName: "Byron Escober", cells: ["10:25"], grandTotal: "10:25" }],
      columnTotals: ["10:25"],
      grandTotal: "10:25",
    };
    render(<ReportPivotTable grid={workTimeGrid} />);
    expect(screen.getAllByText("10:25").length).toBe(4);
  });
});
