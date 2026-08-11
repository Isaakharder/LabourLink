import { useCallback, useEffect, useState } from "react";
import { useWorkSession } from "../../context/WorkSessionContext";
import { api } from "../../lib/api";

interface WeekActivityStat {
  activityId: string;
  activityName: string;
  speedUnit: string | null;
  totalQuantity: number;
  totalDurationSeconds: number;
  averageSpeed: number;
}

interface WeekStat {
  offset: number;
  weekStart: string; // YYYY-MM-DD, Monday
  weekEnd: string; // YYYY-MM-DD, Sunday
  activities: WeekActivityStat[];
}

interface StatsResponse {
  weeks: WeekStat[];
}

const WEEK_LABELS = ["This Week", "Last Week", "2 Weeks Ago", "3 Weeks Ago"];

// dateStr is a plain YYYY-MM-DD calendar date, not an instant — formatted
// via a UTC-anchored Date/UTC-timeZone Intl call so the displayed day never
// shifts depending on the browser's local timezone (the same class of bug
// server/src/lib/reportQueries.ts's to_char comment warns about, just on
// the client side of the same data).
function formatMonthDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

function formatSpeed(value: number, unit: string | null): string {
  return unit ? `${Math.round(value)} ${unit}` : Math.round(value).toString();
}

function formatHours(totalDurationSeconds: number): string {
  return (totalDurationSeconds / 3600).toFixed(1);
}

export function StatsScreen() {
  const { handleApiError } = useWorkSession();
  const [weeks, setWeeks] = useState<WeekStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(() => {
    api<StatsResponse>("/api/mobile/stats")
      .then((res) => {
        setWeeks(res.weeks);
        setError(null);
      })
      .catch((err) => {
        if (!handleApiError(err)) setError("Could not load stats");
      });
  }, [handleApiError]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    window.addEventListener("online", loadStats);
    return () => window.removeEventListener("online", loadStats);
  }, [loadStats]);

  return (
    <div className="mobile-stats">
      <h1>Stats</h1>

      {error && !weeks && <p className="error-text">{error}</p>}
      {!weeks && !error && <p className="mobile-stats-loading">Loading...</p>}

      {weeks && (
        <div className="stats-week-list">
          {weeks.map((week) => (
            <div key={week.offset} className="stats-week-card">
              <div className="stats-week-label">{WEEK_LABELS[week.offset] ?? `${week.offset} Weeks Ago`}</div>
              <div className="stats-week-range">
                {formatMonthDay(week.weekStart)} – {formatMonthDay(week.weekEnd)}
              </div>

              {week.activities.length === 0 ? (
                <p className="stats-week-empty">No speed data this week</p>
              ) : (
                <div className="stats-activity-list">
                  {week.activities.map((activity) => (
                    <div key={activity.activityId} className="stats-activity">
                      <div className="stats-activity-name">{activity.activityName}</div>
                      <div className="stats-activity-speed">
                        {formatSpeed(activity.averageSpeed, activity.speedUnit)}
                      </div>
                      <div className="stats-activity-hours">{formatHours(activity.totalDurationSeconds)} hrs</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
