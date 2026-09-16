import { useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { computeBarPosition, buildTimelineMonthMarks, percentInRange, TimelineRange } from "../../lib/employmentTimeline";
import { EmploymentPeriod, EmploymentTimelineEmployee, TIMELINE_BAR_LABEL_TEXT } from "../../lib/employmentPeriodTypes";

interface EmploymentTimelineGraphProps {
  employees: EmploymentTimelineEmployee[];
  range: TimelineRange;
  today: string;
  // Multiplies the baseline pixels-per-day density — 1 is the default
  // "Fit all" baseline; only ever matters once the range is long enough
  // that BASELINE_PX_PER_DAY * totalDays exceeds the container's own
  // width, at which point the wrapper (overflow-x: auto) scrolls
  // horizontally instead of squeezing everything unreadably thin.
  zoom: number;
  canEdit: boolean;
  // Incremented by the Today button — this component scrolls the today
  // line into view in response, rather than the parent needing a DOM ref
  // into a component it doesn't otherwise touch.
  scrollToTodayToken: number;
  onBarClick: (employee: EmploymentTimelineEmployee, period: EmploymentPeriod) => void;
  onAddPeriod: (employee: EmploymentTimelineEmployee) => void;
}

function barStateClass(label: EmploymentPeriod["timelineLabel"]): string {
  if (label === "completed") return "employment-timeline-bar-completed";
  if (label === "expiredStillWorking") return "employment-timeline-bar-expired-still-working";
  if (label === "ongoing") return "employment-timeline-bar-ongoing";
  return "employment-timeline-bar-current"; // "employed" — a normal in-progress bar with a real, future end
}

const LEGEND: { className: string; label: string }[] = [
  { className: "employment-timeline-bar-current", label: "Employed (scheduled finish/expiry)" },
  { className: "employment-timeline-bar-ongoing", label: "Ongoing (no end in sight)" },
  { className: "employment-timeline-bar-expired-still-working", label: "Expired — still working" },
  { className: "employment-timeline-bar-completed", label: "Completed" },
];

// Baseline density for the "Fit all" default — see the `zoom` prop comment.
const BASELINE_PX_PER_DAY = 3;

export function EmploymentTimelineGraph({ employees, range, today, zoom, canEdit, scrollToTodayToken, onBarClick, onAddPeriod }: EmploymentTimelineGraphProps) {
  const monthMarks = buildTimelineMonthMarks(range);
  const todayLeftPercent = percentInRange(today, range);
  const rangeDays = Math.max(1, Math.round((new Date(range.end).getTime() - new Date(range.start).getTime()) / 86400000));
  // A plain min-width (not a CSS Grid item's implicit-min-size trick) —
  // this component used to rely on CSS Grid + a sticky first column to
  // freeze the employee names while the date track scrolled, but a sticky
  // descendant a few thousand pixels into a long scroll silently stopped
  // tracking (a genuine browser bug, confirmed with a bare manual
  // `scrollLeft` assignment — nothing to do with React or scrollIntoView),
  // discovered while screenshotting a multi-year "Fit all" range. The names
  // column is now a fully separate, non-scrolling panel instead (see
  // .employment-timeline-names-panel/.employment-timeline-graph-wrap
  // below) — a frozen column that can never "un-freeze" because it was
  // never inside the scrolling element to begin with.
  const trackMinWidthPx = rangeDays * BASELINE_PX_PER_DAY * zoom;

  const todayAnchorRef = useRef<HTMLDivElement>(null);
  // Compares against the PREVIOUS token rather than a mutable "is this the
  // first render" flag: a boolean flag flips permanently on the first
  // effect run and stays flipped through React 18 StrictMode's dev-only
  // double-invocation of effects, which would otherwise fire an unwanted
  // scroll-to-today on every mount. Comparing values instead is safe under
  // double-invocation — the second simulated run sees the same (unchanged)
  // token and correctly still skips.
  const prevTokenRef = useRef(scrollToTodayToken);
  useEffect(() => {
    if (scrollToTodayToken !== prevTokenRef.current) {
      prevTokenRef.current = scrollToTodayToken;
      todayAnchorRef.current?.scrollIntoView?.({ inline: "center", block: "nearest" });
    }
  }, [scrollToTodayToken]);

  return (
    <div className="employment-timeline-graph-outer">
      <div className="employment-timeline-split">
        <div className="employment-timeline-names-panel">
          <div className="employment-timeline-header-cell employment-timeline-names-header">Employee</div>
          {employees.map((emp) => {
            const name = `${emp.firstName} ${emp.lastName}`;
            return (
              <div key={emp.id} className="employment-timeline-name-cell">
                <span className="employment-timeline-name-text" title={!emp.hasUsableDates ? "No start date or employment period recorded for this employee" : undefined}>
                  {name}
                  {!emp.hasUsableDates && <span className="employment-timeline-no-dates">(no dates)</span>}
                </span>
                {canEdit && (
                  <button type="button" className="employment-timeline-add-period-btn" onClick={() => onAddPeriod(emp)} title="Add employment period" aria-label={`Add employment period for ${name}`}>
                    <Plus size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="employment-timeline-graph-wrap">
          <div className="employment-timeline-graph">
            <div className="employment-timeline-header-track" style={{ minWidth: `${trackMinWidthPx}px` }}>
              {monthMarks.map((m) => (
                <div key={m.key} className="employment-timeline-month-mark" style={{ left: `${m.leftPercent}%` }}>
                  {m.label}
                </div>
              ))}
              <div ref={todayAnchorRef} className="employment-timeline-today-anchor" style={{ left: `${todayLeftPercent}%` }} aria-hidden="true" />
            </div>

            {employees.map((emp) => (
              <div key={emp.id} className="employment-timeline-track" style={{ minWidth: `${trackMinWidthPx}px`, position: "relative" }}>
                <div className="employment-timeline-today-marker" style={{ left: `${todayLeftPercent}%` }} />

                {emp.hasUsableDates && (
                  <>
                    {emp.workPermit &&
                      emp.workPermit.expiryDate >= range.start &&
                      emp.workPermit.expiryDate <= range.end &&
                      (() => {
                        const left = percentInRange(emp.workPermit!.expiryDate, range);
                        return (
                          <div
                            className="employment-timeline-permit-marker"
                            style={{ left: `${left}%` }}
                            title={`Work permit expires ${emp.workPermit!.expiryDate}`}
                            aria-label={`Work permit expires ${emp.workPermit!.expiryDate}`}
                          />
                        );
                      })()}
                    {emp.periods.map((period) => {
                      const pos = computeBarPosition(period, range);
                      const label = TIMELINE_BAR_LABEL_TEXT[period.timelineLabel];
                      const endText =
                        period.timelineLabel === "ongoing" || period.timelineLabel === "expiredStillWorking" ? "present" : period.timelineEffectiveEndDate;
                      const tooltip = [
                        `${label}: ${period.startDate} – ${endText}`,
                        period.employmentType ? `Type: ${period.employmentType}` : null,
                        period.workGroup ? `Work Group: ${period.workGroup}` : null,
                      ]
                        .filter(Boolean)
                        .join("\n");
                      const clickable = canEdit && !period.synthesized;
                      return (
                        <button
                          key={period.id}
                          type="button"
                          disabled={!clickable}
                          className={`employment-timeline-bar ${barStateClass(period.timelineLabel)}${period.synthesized ? " employment-timeline-bar-synthesized" : ""}`}
                          style={{ left: `${pos.leftPercent}%`, width: `${pos.widthPercent}%` }}
                          onClick={clickable ? () => onBarClick(emp, period) : undefined}
                          title={tooltip}
                        >
                          <span className="employment-timeline-bar-label">{label}</span>
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Outside the scrolling wrap — see the split-layout comment above for
          why the names column had to move out of it; the legend has the
          same "must never scroll away" requirement, discovered the same
          way (screenshotting a "jump to Today" scroll on a multi-year
          range). */}
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
