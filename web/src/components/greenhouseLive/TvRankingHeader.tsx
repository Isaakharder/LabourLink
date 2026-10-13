import { ReactNode } from "react";
import { ActivitySlide, ReportWeek } from "../../lib/greenhouseLiveTypes";
import { graphSpeedUnit } from "../../lib/speedUnitDisplay";

interface TvRankingHeaderProps {
  displayName: string;
  slide: ActivitySlide;
  week: ReportWeek | null; // null until the first slides response
  // Far right of the second row: "Updated …", or a compact reconnecting
  // notice when the rankings are stale. Slide dots follow it.
  status: ReactNode;
  dots: ReactNode;
}

// The compact two-row header shared by every activity ranking slide (any
// activity, any unit) — the map slide keeps the page's own header. Every
// piece stays on one line so the chart gets the screen:
//
//   Break Area TV                                  Winding & Pruning
//   This week · Target: 700 stm/hr · Employees: 12     Updated 10:42 AM
//
// Deliberately not shown here (the settings and their filtering still
// apply): Top N, minimum hours, the full dates and "including today".
export function TvRankingHeader({ displayName, slide, week, status, dots }: TvRankingHeaderProps) {
  // The bars actually on this slide (the server has already applied Top N and
  // the minimum hours). A notice slide has no bars and shows no count — the
  // TV never puts a bare zero next to "No speeds yet".
  const employeeCount = slide.status === "ok" ? slide.employees.length : null;
  return (
    <div className="greenhouse-tv-header tv-ranking-header">
      <div className="tv-ranking-header-row">
        <h1 className="tv-ranking-header-name" title={displayName}>
          {displayName}
        </h1>
        <p className="tv-ranking-header-activity" title={slide.activityName}>
          {slide.activityName}
        </p>
      </div>
      <div className="tv-ranking-header-row tv-ranking-header-meta">
        {week && <span>{week === "last_week" ? "Last week" : "This week"}</span>}
        {slide.target != null && (
          <span>
            <b>Target:</b> {Math.round(slide.target)} {graphSpeedUnit(slide.speedUnit)}
          </span>
        )}
        {employeeCount != null && (
          <span>
            <b>Employees:</b> {employeeCount}
          </span>
        )}
        <span className="tv-ranking-header-status">
          {status}
          {dots}
        </span>
      </div>
    </div>
  );
}
