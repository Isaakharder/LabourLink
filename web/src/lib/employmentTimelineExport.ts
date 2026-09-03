// CSV/PDF/Print export for the Employment Timeline table view — same
// library/pattern as reportExport.ts (csvEscape/triggerDownload,
// jsPDF+autoTable, window.print() for a temporary @page orientation),
// applied to a different data shape (one row per employment period, not a
// date-column matrix). Reads the exact same buildEmploymentTimelineRows
// output the on-screen table renders (employmentTimeline.ts), so CSV/PDF/
// screen can never disagree about a value.
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { buildEmploymentTimelineRows } from "./employmentTimeline";
import { EmploymentTimelineEmployee } from "./employmentPeriodTypes";

const HEADER = ["Employee", "Nationality", "Work Group", "Employment Type", "Start", "Expected Finish", "Actual Finish", "Status"];

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

export function exportEmploymentTimelineCsv(employees: EmploymentTimelineEmployee[]) {
  const rows = buildEmploymentTimelineRows(employees);
  const lines = [HEADER.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(
      [row.employeeName, row.nationality, row.workGroup, row.employmentType, row.startDate, row.expectedFinishDate, row.actualFinishDate, row.status]
        .map(csvEscape)
        .join(",")
    );
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, "Employment Timeline.csv");
}

export type EmploymentTimelineOrientation = "portrait" | "landscape";

export function exportEmploymentTimelinePdf(employees: EmploymentTimelineEmployee[], orientation: EmploymentTimelineOrientation = "landscape") {
  const rows = buildEmploymentTimelineRows(employees);
  const doc = new jsPDF({ orientation });

  doc.setFontSize(16);
  doc.text("LabourLink", 14, 16);
  doc.setFontSize(12);
  doc.text("Employment Timeline", 14, 24);
  doc.setFontSize(10);
  doc.text(`Generated ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`, 14, 30);

  const body = rows.map((row) => [row.employeeName, row.nationality, row.workGroup, row.employmentType, row.startDate, row.expectedFinishDate || "—", row.actualFinishDate || "—", row.status]);

  autoTable(doc, {
    startY: 36,
    head: [HEADER],
    body,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [40, 90, 60] },
    tableWidth: "auto",
    showHead: "everyPage",
  });

  doc.save("Employment Timeline.pdf");
}

// Same temporary @page injection + window.print() pattern as
// reportExport.ts's printReport — the actual print CONTENT comes from
// index.css's @media print block scoped to .employment-timeline-view.
export function printEmploymentTimeline(orientation: EmploymentTimelineOrientation) {
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
