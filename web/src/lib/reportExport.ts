// CSV/PDF export for the Reports page. CSV is a plain string build (no
// dependency). PDF uses jsPDF + jspdf-autotable to draw an actual
// structured table of text — never a screenshot of the on-screen table —
// per the brief's "do not depend on screenshots" requirement. Both report
// types (Activity and Payroll) render as the same employee x day matrix
// (ReportPivotTable), so a single pair of pivot export functions covers
// both — no per-report-type export code to keep in sync.
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { abbreviateSpeedCellText, DateRange, SavedReportDetail } from "./reportTypes";
import { PivotGrid, formatPivotDateHeader } from "./reportPivot";

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// Matrix-shaped exports — the same PivotGrid the on-screen ReportPivotTable
// renders from, so CSV/PDF/screen can never disagree about a value. One
// employee per row (employeeId is PivotGrid.employees' key), one column per
// selected date, Employee Total on the right, DAY TOTAL on the bottom.
// Deliberately reads grid values as-is, never through
// abbreviateSpeedCellText — an Average Speed CSV must stay unambiguous
// outside the app's own visual context (no accompanying note column/row
// exists in a CSV the way there is above the on-screen/PDF table), so the
// unit stays fully spelled out ("stems/hour"/"plants/hour") here.
export function exportPivotCsv(report: SavedReportDetail, grid: PivotGrid, metricLabel: string) {
  // Same single source of truth ReportPivotTable uses — the column appears
  // here exactly when (and only when) it appears on screen/PDF, since all
  // three read the same grid.totalPaidTimeGrandTotal presence.
  const showPaidTimeTotal = grid.totalPaidTimeGrandTotal !== undefined;
  const lines: string[] = [];
  const header = ["Employee", ...grid.dates.map(formatPivotDateHeader), "Employee Total"];
  if (showPaidTimeTotal) header.push("Total Paid Time");
  lines.push(header.map(csvEscape).join(","));
  for (const row of grid.employees) {
    const cells = [row.employeeName, ...row.cells, row.grandTotal];
    if (showPaidTimeTotal) cells.push(row.totalPaidTime ?? "—");
    lines.push(cells.map(csvEscape).join(","));
  }
  const totalsRow = ["DAY TOTAL", ...grid.columnTotals, grid.grandTotal];
  if (showPaidTimeTotal) totalsRow.push(grid.totalPaidTimeGrandTotal!);
  lines.push(totalsRow.map(csvEscape).join(","));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, `${report.name.replace(/[^\w\- ]+/g, "")} - ${metricLabel}.csv`);
}

export type ReportOrientation = "portrait" | "landscape";

export function exportPivotPdf(
  report: SavedReportDetail,
  dateRange: DateRange,
  grid: PivotGrid,
  metricLabel: string,
  orientation: ReportOrientation = "landscape",
  // The Average-Speed unit-abbreviation explanation (see
  // reportTypes.ts's speedUnitAbbreviationNote) — null whenever the
  // selected metric isn't Average Speed or the unit has no abbreviation.
  // Unlike CSV, the PDF (like the on-screen table) DOES abbreviate its
  // speed cells below, so it needs this note printed alongside them for
  // the same reason the screen does.
  speedUnitNote: string | null = null
) {
  const doc = new jsPDF({ orientation });

  doc.setFontSize(16);
  doc.text("LabourLink", 14, 16);
  doc.setFontSize(12);
  doc.text(report.name, 14, 24);
  doc.setFontSize(10);
  const subtitleParts = [
    report.reportType === "activity" ? "Activity Report" : "Payroll Report",
    report.activity ? report.activity.name : null,
    `${dateRange.start} – ${dateRange.end}`,
    `Metric: ${metricLabel}`,
    `Generated ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`,
  ].filter(Boolean);
  doc.text(subtitleParts.join(" · "), 14, 30);

  let tableStartY = 36;
  if (speedUnitNote) {
    doc.setFontSize(9);
    doc.text(speedUnitNote, 14, 35);
    tableStartY = 40;
  }

  // Same single source of truth ReportPivotTable/CSV use — see
  // exportPivotCsv's own comment.
  const showPaidTimeTotal = grid.totalPaidTimeGrandTotal !== undefined;
  const head = ["Employee", ...grid.dates.map(formatPivotDateHeader), "Employee Total"];
  if (showPaidTimeTotal) head.push("Total Paid Time");
  // Abbreviated the same way the on-screen table is (abbreviateSpeedCellText
  // is a no-op for any non-speed cell) — the PDF is a visual document like
  // the screen, not a data interchange format like CSV, so it gets the
  // compact form plus the note above, not the full spelled-out unit.
  const body = grid.employees.map((row) => {
    const cells = [row.employeeName, ...row.cells.map(abbreviateSpeedCellText), abbreviateSpeedCellText(row.grandTotal)];
    if (showPaidTimeTotal) cells.push(row.totalPaidTime ?? "—");
    return cells;
  });
  const totalsRow = ["DAY TOTAL", ...grid.columnTotals.map(abbreviateSpeedCellText), abbreviateSpeedCellText(grid.grandTotal)];
  if (showPaidTimeTotal) totalsRow.push(grid.totalPaidTimeGrandTotal!);
  body.push(totalsRow);

  autoTable(doc, {
    startY: tableStartY,
    head: [head],
    body,
    styles: { fontSize: 7 },
    headStyles: { fillColor: [40, 90, 60] },
    // Table always uses the page's own printable width (autoTable's
    // default "auto" tableWidth) — a landscape page is simply wider, so
    // more date columns fit before the same column-shrinking kicks in;
    // no column is ever dropped to make room, only narrowed.
    tableWidth: "auto",
    // Explicit rather than relying on autoTable's own default — a long
    // employee list spans multiple PDF pages, and the header must repeat
    // on each one rather than only appearing once at the top.
    showHead: "everyPage",
    // Bolds the DAY TOTAL row (last body row) and every total COLUMN —
    // Employee Total always, plus Total Paid Time when present (the new
    // trailing column, not necessarily the visually-last one if this ever
    // grows a third) — a visual cue only, the values themselves come
    // straight from PivotGrid either way.
    didParseCell: (data) => {
      const isTotalRow = data.row.index === body.length - 1 && data.section === "body";
      const employeeTotalColIndex = showPaidTimeTotal ? head.length - 2 : head.length - 1;
      const isTotalCol = data.column.index === employeeTotalColIndex || (showPaidTimeTotal && data.column.index === head.length - 1);
      if (isTotalRow || isTotalCol) {
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  doc.save(`${report.name.replace(/[^\w\- ]+/g, "")} - ${metricLabel}.pdf`);
}

// Injects an @page rule for the requested orientation immediately before
// invoking the browser's print dialog, then removes it once printing is
// done (or the dialog is dismissed) — @page has no class/selector-based
// scoping mechanism, so a temporary <style> tag is the standard way to
// control print orientation per-action rather than via a fixed stylesheet
// rule. The actual print CONTENT still comes from the real page's existing
// print CSS (index.css's @media print block) — this only controls the
// page's paper orientation, it doesn't render anything itself.
export function printReport(orientation: ReportOrientation) {
  const style = document.createElement("style");
  style.textContent = `@page { size: ${orientation}; margin: 12mm; }`;
  document.head.appendChild(style);

  function cleanup() {
    style.remove();
    window.removeEventListener("afterprint", cleanup);
  }
  window.addEventListener("afterprint", cleanup);

  window.print();
}
