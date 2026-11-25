import { ReactNode } from "react";
import {
  ACTIVITY_METRIC_LABELS,
  REPORT_METRIC_CHOICES,
  REPORT_METRIC_HINTS,
  ReportJobInfo,
  ReportMetricChoice,
  reportMetricUnavailableReason,
} from "../../lib/reportTypes";

interface ReportMetricPickerProps {
  dailyMetric: ReportMetricChoice;
  summaryMetrics: ReportMetricChoice[];
  // null while the Job isn't known yet: every choice is offered.
  job: ReportJobInfo | null;
  onDailyMetricChange: (metric: ReportMetricChoice) => void;
  onSummaryMetricsChange: (metrics: ReportMetricChoice[]) => void;
  // Shown at the end of the row (e.g. Save / Cancel).
  actions?: ReactNode;
}

// One dropdown for the Monday–Sunday cells and a wrapping row of checkboxes
// for the right-hand summary columns, chosen independently. Choices that
// don't apply to the Job (Kg/Hr without LabourLink Scale, Plants/Hr on a
// stems Job, ...) stay visible but disabled, with the reason as a tooltip.
export function ReportMetricPicker({ dailyMetric, summaryMetrics, job, onDailyMetricChange, onSummaryMetricsChange, actions }: ReportMetricPickerProps) {
  function toggle(choice: ReportMetricChoice) {
    // Kept in the fixed choice order so the columns never reshuffle.
    const next = summaryMetrics.includes(choice) ? summaryMetrics.filter((m) => m !== choice) : [...summaryMetrics, choice];
    onSummaryMetricsChange(REPORT_METRIC_CHOICES.filter((c) => next.includes(c)));
  }

  return (
    <div className="report-metric-picker">
      <label className="report-metric-picker-daily">
        <span className="report-metric-picker-label">Daily cells</span>
        <select value={dailyMetric} onChange={(e) => onDailyMetricChange(e.target.value as ReportMetricChoice)}>
          {REPORT_METRIC_CHOICES.map((c) => {
            const reason = reportMetricUnavailableReason(c, job);
            return (
              <option key={c} value={c} disabled={reason != null && c !== dailyMetric} title={reason ?? REPORT_METRIC_HINTS[c]}>
                {ACTIVITY_METRIC_LABELS[c]}
                {reason ? " (n/a)" : ""}
              </option>
            );
          })}
        </select>
      </label>
      <div className="report-metric-picker-summary" role="group" aria-label="Summary columns">
        <span className="report-metric-picker-label">Summary columns</span>
        <div className="report-metric-chips">
          {REPORT_METRIC_CHOICES.map((c) => {
            const reason = reportMetricUnavailableReason(c, job);
            const checked = summaryMetrics.includes(c);
            return (
              <label
                key={c}
                className={`report-metric-chip${checked ? " is-checked" : ""}${reason ? " is-unavailable" : ""}`}
                title={reason ?? REPORT_METRIC_HINTS[c]}
              >
                <input type="checkbox" checked={checked} disabled={reason != null && !checked} onChange={() => toggle(c)} />
                {ACTIVITY_METRIC_LABELS[c]}
              </label>
            );
          })}
        </div>
      </div>
      {actions && <div className="report-metric-picker-actions">{actions}</div>}
      {summaryMetrics.length === 0 && <p className="error-text report-metric-picker-error">Choose at least one summary column</p>}
    </div>
  );
}
