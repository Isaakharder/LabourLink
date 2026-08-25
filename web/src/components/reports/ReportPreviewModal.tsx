import { useState } from "react";
import { Modal } from "../ui/Modal";
import { ReportPivotTable } from "./ReportPivotTable";
import { PivotGrid } from "../../lib/reportPivot";
import { DateRange, SavedReportDetail } from "../../lib/reportTypes";
import { ReportOrientation } from "../../lib/reportExport";

interface ReportPreviewModalProps {
  report: SavedReportDetail;
  dateRange: DateRange;
  grid: PivotGrid;
  metricLabel: string;
  mode: "print" | "pdf";
  // The Average-Speed unit-abbreviation explanation (see
  // reportTypes.ts's speedUnitAbbreviationNote) — null whenever the
  // selected metric isn't Average Speed or the unit has no abbreviation.
  note?: string | null;
  onClose: () => void;
  onConfirm: (orientation: ReportOrientation) => void;
}

// Lightweight confirmation step for Print/Export PDF — reuses the same
// ReportPivotTable and PivotGrid the real screen/export already render
// from (no separate report-rendering engine), just wrapped in a
// page-shaped container so switching Portrait/Landscape gives an
// approximate sense of how the table will fit, per the brief.
export function ReportPreviewModal({ report, dateRange, grid, metricLabel, mode, note, onClose, onConfirm }: ReportPreviewModalProps) {
  // Wide reports (many date columns) default to landscape, since that's
  // almost always the better fit — the user can still switch either way.
  const [orientation, setOrientation] = useState<ReportOrientation>(grid.dates.length > 7 ? "landscape" : "portrait");

  return (
    <Modal
      title={mode === "print" ? "Print Preview" : "Export PDF Preview"}
      onClose={onClose}
      xl
      footer={
        <div className="report-preview-footer">
          <div className="report-preview-orientation-toggle">
            <button
              type="button"
              className={`report-date-preset${orientation === "portrait" ? " report-toggle-active" : ""}`}
              onClick={() => setOrientation("portrait")}
            >
              Portrait
            </button>
            <button
              type="button"
              className={`report-date-preset${orientation === "landscape" ? " report-toggle-active" : ""}`}
              onClick={() => setOrientation("landscape")}
            >
              Landscape
            </button>
          </div>
          <div className="employee-form-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="employee-form-save" onClick={() => onConfirm(orientation)}>
              {mode === "print" ? "Print" : "Export PDF"}
            </button>
          </div>
        </div>
      }
    >
      <div className="report-preview-meta">
        <h3>{report.name}</h3>
        <p>
          {report.reportType === "activity" ? "Activity Report" : "Payroll Report"}
          {report.activity ? ` · ${report.activity.name}` : ""}
          {" · "}
          {dateRange.start} – {dateRange.end}
          {" · "}
          {metricLabel}
        </p>
      </div>

      <div className={`report-preview-page report-preview-page-${orientation}`}>
        <div className="report-preview-page-inner">
          {note && <p className="report-pivot-unit-note">{note}</p>}
          <ReportPivotTable grid={grid} />
        </div>
      </div>
    </Modal>
  );
}
