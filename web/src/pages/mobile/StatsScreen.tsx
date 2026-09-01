import { useCallback, useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { useWorkSession } from "../../context/WorkSessionContext";
import { api } from "../../lib/api";
import { Language, t } from "../../lib/i18n";

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

function weekLabel(language: Language, offset: number): string {
  if (offset === 0) return t(language, "weekThisWeek");
  if (offset === 1) return t(language, "weekLastWeek");
  return t(language, "weekNWeeksAgo", { n: offset });
}

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
  const { language, online, handleApiError } = useWorkSession();
  const [weeks, setWeeks] = useState<WeekStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set only when the LAST load attempt failed specifically because the
  // server couldn't be reached (handleApiError's own network-error case) —
  // distinct from `error` (a real, specific rejection). Stats has no
  // local-first computation at all (unlike Home's status, it's entirely
  // server-driven — see this component's own loadStats), so the honest
  // state offline is either "never loaded yet" or "showing what was last
  // successfully loaded, which may now be stale" — never a locally
  // recomputed total, and never silently presented as current. This is
  // exactly the "final day totals aren't available until synchronization"
  // case: a still-open, not-yet-midnight-reconciled entry is structurally
  // excluded from every total here (getActivityDensityAttribution only
  // ever sums CLOSED segments), so numbers shown can under-represent an
  // in-progress day, never inflate one — but that under-representation
  // must be visible, not silent.
  const [offline, setOffline] = useState(false);

  const loadStats = useCallback(() => {
    api<StatsResponse>("/api/mobile/stats")
      .then((res) => {
        setWeeks(res.weeks);
        setError(null);
        setOffline(false);
      })
      .catch((err) => {
        if (handleApiError(err)) {
          setOffline(true);
        } else {
          setError(t(language, "statsLoadError"));
        }
      });
  }, [handleApiError, language]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    window.addEventListener("online", loadStats);
    return () => window.removeEventListener("online", loadStats);
  }, [loadStats]);

  return (
    <div className="mobile-stats">
      {/* App navigation (React Router), never browser/hardware back — same
          reasoning as SettingsScreen's identical header: a plain back
          gesture could just as easily leave LabourLink entirely (e.g. this
          screen reached from a push notification), which isn't reliably
          "the job/activity picker" at all. This always goes to exactly one
          place — Home, where an employee picks their activity/row/etc. */}
      <div className="mobile-settings-header">
        <Link to="/mobile/home" className="mobile-settings-back" aria-label={t(language, "statsBackToHome")}>
          <ChevronLeft size={22} aria-hidden="true" />
        </Link>
        <h1>{t(language, "statsTitle")}</h1>
      </div>

      {error && !weeks && <p className="error-text">{error}</p>}
      {/* Offline and never successfully loaded — the honest state is "not
          available yet," never an indefinite unlabeled spinner (which reads
          as broken/hung, not as "you're offline"). */}
      {!weeks && !error && offline && <p className="mobile-offline-banner">{t(language, "statsOfflineNeverLoaded")}</p>}
      {!weeks && !error && !offline && <p className="mobile-stats-loading">{t(language, "loading")}</p>}

      {/* Offline but showing data from an earlier successful load — labeled
          as possibly stale rather than presented as current. Never shows
          inflated numbers either way: a still-open, not-yet-reconciled
          entry is structurally excluded from every total here (see this
          file's own header), so the risk is under-representing today, not
          overstating it — but that has to be visible, not silent. */}
      {weeks && !online && <p className="mobile-offline-banner">{t(language, "statsOfflineStale")}</p>}

      {weeks && (
        <div className="stats-week-list">
          {weeks.map((week) => (
            <div key={week.offset} className="stats-week-card">
              <div className="stats-week-label">{weekLabel(language, week.offset)}</div>
              <div className="stats-week-range">
                {formatMonthDay(week.weekStart)} – {formatMonthDay(week.weekEnd)}
              </div>

              {week.activities.length === 0 ? (
                <p className="stats-week-empty">{t(language, "statsNoData")}</p>
              ) : (
                <div className="stats-activity-list">
                  {week.activities.map((activity) => (
                    <div key={activity.activityId} className="stats-activity">
                      <div className="stats-activity-name">{activity.activityName}</div>
                      <div className="stats-activity-speed">
                        {formatSpeed(activity.averageSpeed, activity.speedUnit)}
                      </div>
                      <div className="stats-activity-hours">
                        {formatHours(activity.totalDurationSeconds)} {t(language, "statsHoursSuffix")}
                      </div>
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
