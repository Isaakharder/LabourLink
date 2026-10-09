// Pure slideshow logic for the TV display (GreenhouseDisplayPage): which
// slides to show, in what order, for how long, and how old retained data is.
import { ActivitySlide, ReportWeek } from "./greenhouseLiveTypes";
import { addCalendarDays, startOfWeekMonday } from "./timezone";

export type SlideItem =
  | { kind: "map"; key: string; seconds: number }
  | { kind: "activity"; key: string; seconds: number; slide: ActivitySlide };

// Map first, then one slide per activity with EVERY eligible employee on it
// (the bar chart sizes itself to fit — no pagination). Top N, when chosen,
// is already applied by the server. With no activity slides the map is the
// only item and the TV simply stays on it.
export function buildSlideSequence(slides: ActivitySlide[] | null | undefined, mapSeconds: number): SlideItem[] {
  const items: SlideItem[] = [{ kind: "map", key: "map", seconds: mapSeconds }];
  for (const slide of slides ?? []) {
    items.push({ kind: "activity", key: slide.activityId, seconds: slide.slideSeconds, slide });
  }
  return items;
}

// After the sequence changes (new data), stay on the same slide if it still
// exists, otherwise go back to the map.
export function indexAfterUpdate(previous: SlideItem | undefined, next: SlideItem[]): number {
  if (!previous) return 0;
  const i = next.findIndex((item) => item.key === previous.key);
  return i >= 0 ? i : 0;
}

export function formatAge(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return "less than a minute";
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

// Data is "stale" once a refresh has been missed — at least two poll
// intervals since the last success.
export function isStale(lastSuccessMs: number | null, nowMs: number, pollMs: number): boolean {
  return lastSuccessMs !== null && nowMs - lastSuccessMs > pollMs * 2;
}

export function formatSpeed(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

// Mirror of the server's resolveReportingPeriod (server/src/lib/
// displayPeriods.ts), so Display > Setup can show the exact dates while
// settings are being edited. The TV itself always uses the server's answer.
export function reportingPeriodFor(
  week: ReportWeek,
  includeToday: boolean,
  today: string
): { dateStart: string; dateEnd: string; empty: boolean } {
  const monday = startOfWeekMonday(today);
  if (week === "last_week") {
    const s = addCalendarDays(monday, -7);
    return { dateStart: s, dateEnd: addCalendarDays(s, 6), empty: false };
  }
  const end = includeToday ? today : addCalendarDays(today, -1);
  if (end < monday) return { dateStart: monday, dateEnd: monday, empty: true };
  return { dateStart: monday, dateEnd: end, empty: false };
}
