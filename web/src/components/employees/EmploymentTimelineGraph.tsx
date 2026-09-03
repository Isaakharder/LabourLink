import { Plus } from "lucide-react";
import { computeBarPosition, TimelineColumn } from "../../lib/employmentTimeline";
import { EmploymentPeriod, EmploymentTimelineEmployee } from "../../lib/employmentPeriodTypes";

interface EmploymentTimelineGraphProps {
  employees: EmploymentTimelineEmployee[];
  columns: TimelineColumn[];
  today: string;
  canEdit: boolean;
  onBarClick: (employee: EmploymentTimelineEmployee, period: EmploymentPeriod) => void;
  onAddPeriod: (employee: EmploymentTimelineEmployee) => void;
}

function barStateClass(period: EmploymentPeriod): string {
  if (period.statuses.includes("overdue")) return "employment-timeline-bar-overdue";
  if (period.statuses.includes("completed")) return "employment-timeline-bar-completed";
  if (period.statuses.includes("future") || period.statuses.includes("startingSoon")) return "employment-timeline-bar-planned";
  return "employment-timeline-bar-current";
}

function barStateLabel(period: EmploymentPeriod): string {
  if (period.statuses.includes("overdue")) return "Overdue";
  if (period.statuses.includes("completed")) return "Finished";
  if (period.statuses.includes("future") || period.statuses.includes("startingSoon")) return "Planned";
  return "Employed";
}

const LEGEND = [
  { className: "employment-timeline-bar-current", label: "Currently employed" },
  { className: "employment-timeline-bar-planned", label: "Future/planned" },
  { className: "employment-timeline-bar-completed", label: "Completed" },
  { className: "employment-timeline-bar-overdue", label: "Expected finish passed, no actual finish recorded" },
];

export function EmploymentTimelineGraph({ employees, columns, today, canEdit, onBarClick, onAddPeriod }: EmploymentTimelineGraphProps) {
  const todayColIndex = columns.findIndex((c) => today >= c.startDate && today <= c.endDate);
  const gridTemplateColumns = `220px repeat(${columns.length}, minmax(28px, 1fr))`;

  return (
    <div className="employment-timeline-graph-wrap">
      <div className="employment-timeline-graph" style={{ gridTemplateColumns, width: "max-content" }}>
        <div className="employment-timeline-header-cell employment-timeline-employee-col">Employee</div>
        {columns.map((c) => (
          <div key={c.key} className="employment-timeline-header-cell">
            {c.label}
          </div>
        ))}

        {employees.map((emp) => {
          const name = `${emp.firstName} ${emp.lastName}`;
          return (
            <div className="employment-timeline-row" key={emp.id} style={{ display: "contents" }}>
              <div className="employment-timeline-employee-col employment-timeline-name-cell">
                <span>{name}</span>
                {canEdit && (
                  <button type="button" className="employment-timeline-add-period-btn" onClick={() => onAddPeriod(emp)} title="Add employment period" aria-label={`Add employment period for ${name}`}>
                    <Plus size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="employment-timeline-track" style={{ gridColumn: `2 / span ${columns.length}`, position: "relative" }}>
                {todayColIndex >= 0 && (
                  <div className="employment-timeline-today-marker" style={{ left: `${(todayColIndex / columns.length) * 100}%` }} />
                )}
                {emp.workPermit && (() => {
                  const permitColIndex = columns.findIndex((c) => emp.workPermit!.expiryDate >= c.startDate && emp.workPermit!.expiryDate <= c.endDate);
                  if (permitColIndex < 0) return null;
                  return (
                    <div
                      className="employment-timeline-permit-marker"
                      style={{ left: `${((permitColIndex + 0.5) / columns.length) * 100}%` }}
                      title={`Work permit expires ${emp.workPermit!.expiryDate}`}
                      aria-label={`Work permit expires ${emp.workPermit!.expiryDate}`}
                    />
                  );
                })()}
                {emp.periods.map((period) => {
                  const pos = computeBarPosition(period, columns);
                  if (!pos) return null;
                  const span = pos.endColIndex - pos.startColIndex + 1;
                  return (
                    <button
                      type="button"
                      key={period.id}
                      className={`employment-timeline-bar ${barStateClass(period)}`}
                      style={{ left: `${(pos.startColIndex / columns.length) * 100}%`, width: `${(span / columns.length) * 100}%` }}
                      onClick={() => onBarClick(emp, period)}
                      title={`${barStateLabel(period)}: ${period.startDate} – ${period.actualFinishDate ?? period.expectedFinishDate ?? "ongoing"}`}
                    >
                      <span className="employment-timeline-bar-label">{barStateLabel(period)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="employment-timeline-legend">
        {LEGEND.map((item) => (
          <span key={item.className} className="employment-timeline-legend-item">
            <span className={`employment-timeline-legend-swatch ${item.className}`} aria-hidden="true" />
            {item.label}
          </span>
        ))}
        <span className="employment-timeline-legend-item">
          <span className="employment-timeline-permit-marker employment-timeline-legend-marker" aria-hidden="true" />
          Work permit expiry
        </span>
        <span className="employment-timeline-legend-item">
          <span className="employment-timeline-today-marker employment-timeline-legend-marker" aria-hidden="true" />
          Today
        </span>
      </div>
    </div>
  );
}
