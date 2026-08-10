// CSV/PDF export for the Reports page. CSV is a plain string build (no
// dependency). PDF uses jsPDF + jspdf-autotable to draw an actual
// structured table of text — never a screenshot of the on-screen table —
// per the brief's "do not depend on screenshots" requirement. Both report
// types (Activity and Payroll) render as the same employee x day matrix
// (ReportPivotTable), so a single pair of pivot export functions covers
// both — no per-report-type export code to keep in sync.
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { DateRange, SavedReportDetail } from "./reportTypes";
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
export function exportPivotCsv(report: SavedReportDetail, grid: PivotGrid, metricLabel: string) {
  const lines: string[] = [];
  lines.push(["Employee", ...grid.dates.map(formatPivotDateHeader), "Employee Total"].map(csvEscape).join(","));
  for (const row of grid.employees) {
    lines.push([row.employeeName, ...row.cells, row.grandTotal].map(csvEscape).join(","));
  }
  lines.push(["DAY TOTAL", ...grid.columnTotals, grid.grandTotal].map(csvEscape).join(","));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, `${report.name.replace(/[^\w\- ]+/g, "")} - ${metricLabel}.csv`);
}

export function exportPivotPdf(report: SavedReportDetail, dateRange: DateRange, grid: PivotGrid, metricLabel: string) {
  const doc = new jsPDF({ orientation: "landscape" });

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

  const head = ["Employee", ...grid.dates.map(formatPivotDateHeader), "Employee Total"];
  const body = grid.employees.map((row) => [row.employeeName, ...row.cells, row.grandTotal]);
  body.push(["DAY TOTAL", ...grid.columnTotals, grid.grandTotal]);

  autoTable(doc, {
    startY: 36,
    head: [head],
    body,
    styles: { fontSize: 7 },
    headStyles: { fillColor: [40, 90, 60] },
    // Bolds the DAY TOTAL row (last body row) and Employee Total column
    // (last cell of every row) — a visual cue only, the values themselves
    // come straight from PivotGrid either way.
    didParseCell: (data) => {
      const isTotalRow = data.row.index === body.length - 1 && data.section === "body";
      const isTotalCol = data.column.index === head.length - 1;
      if (isTotalRow || isTotalCol) {
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  doc.save(`${report.name.replace(/[^\w\- ]+/g, "")} - ${metricLabel}.pdf`);
}
