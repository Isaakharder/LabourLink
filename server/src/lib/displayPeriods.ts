// Date math for TV displays (greenhouse_displays, 059_display_slideshow.sql).
// Pure: every function takes "today" as an APP_TIMEZONE calendar date
// (YYYY-MM-DD, from calendarDateInAppTimezone) so week/month rollover is
// testable without a clock. Weeks start on Monday, matching
// getCurrentWeekBoundsUtc and the Dashboard.
import { addDaysToDateStr } from "./timezone";

export const MAP_DATE_PRESETS = ["today", "yesterday", "thisWeek", "lastWeek", "last7", "thisMonth", "lastMonth"] as const;
export type MapDatePreset = (typeof MAP_DATE_PRESETS)[number];

export const REPORT_WEEKS = ["this_week", "last_week"] as const;
export type ReportWeek = (typeof REPORT_WEEKS)[number];

export function isMapDatePreset(v: unknown): v is MapDatePreset {
  return typeof v === "string" && (MAP_DATE_PRESETS as readonly string[]).includes(v);
}

export function isReportWeek(v: unknown): v is ReportWeek {
  return typeof v === "string" && (REPORT_WEEKS as readonly string[]).includes(v);
}

// Monday of the week containing `date`.
export function startOfWeekMonday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysToDateStr(date, -((dow + 6) % 7));
}

function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function endOfMonth(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

// The map's date range for a relative preset, as of `today`. Same ranges the
// office Map page's preset dropdown fills in (web GreenhousePage applyPreset).
export function resolveMapPreset(preset: MapDatePreset, today: string): { dateStart: string; dateEnd: string } {
  switch (preset) {
    case "today":
      return { dateStart: today, dateEnd: today };
    case "yesterday": {
      const y = addDaysToDateStr(today, -1);
      return { dateStart: y, dateEnd: y };
    }
    case "thisWeek": {
      const s = startOfWeekMonday(today);
      return { dateStart: s, dateEnd: addDaysToDateStr(s, 6) };
    }
    case "lastWeek": {
      const s = addDaysToDateStr(startOfWeekMonday(today), -7);
      return { dateStart: s, dateEnd: addDaysToDateStr(s, 6) };
    }
    case "last7":
      return { dateStart: addDaysToDateStr(today, -6), dateEnd: today };
    case "thisMonth":
      return { dateStart: startOfMonth(today), dateEnd: endOfMonth(today) };
    case "lastMonth": {
      const lastMonthDay = addDaysToDateStr(startOfMonth(today), -1);
      return { dateStart: startOfMonth(lastMonthDay), dateEnd: lastMonthDay };
    }
  }
}

// The ranking slides' reporting period. "This week" runs Monday through
// today (or through yesterday without Include today); on a Monday without
// Include today that is no days at all, reported as empty. "Last week" is
// always the full previous Monday–Sunday; Include today doesn't apply.
export function resolveReportingPeriod(
  week: ReportWeek,
  includeToday: boolean,
  today: string
): { dateStart: string; dateEnd: string; empty: boolean } {
  const monday = startOfWeekMonday(today);
  if (week === "last_week") {
    const s = addDaysToDateStr(monday, -7);
    return { dateStart: s, dateEnd: addDaysToDateStr(s, 6), empty: false };
  }
  const end = includeToday ? today : addDaysToDateStr(today, -1);
  if (end < monday) return { dateStart: monday, dateEnd: monday, empty: true };
  return { dateStart: monday, dateEnd: end, empty: false };
}
