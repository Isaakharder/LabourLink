// Employee speed-ranking slides for TV displays (059_display_slideshow.sql).
//
// The speed itself is NOT a new calculation: computeActivitySpeedRows maps
// getActivityReportDataWithAttribution exactly the way the Productive TV
// endpoints do (routes/integrations.ts) — attributed quantity divided by
// that attribution's own duration, via aggregateDensitySpeed. So the Row
// review window, manual review decisions, shared-employee allocation, break
// exclusion, carrier continuity and open-visit handling are all inherited
// unchanged. Read-only: nothing here writes.
import { pool } from "../db";
import { getActivityReportDataWithAttribution } from "./reportQueries";
import { aggregateDensitySpeed } from "./densitySpeed";
import { APP_TIMEZONE, getRangeBoundsUtc } from "./timezone";
import { ReportWeek, resolveReportingPeriod } from "./displayPeriods";

export interface SpeedRow {
  employeeId: string;
  speed: number;
  quantityCounted: number;
  activityHours: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Per-employee speeds for one activity and inclusive local date range —
// byte-for-byte the same mapping as /api/integrations/productive-tv/*-speed.
// Employees with work but no calculable speed are counted, never given 0.
export async function computeActivitySpeedRows(
  activityId: string,
  from: string,
  to: string
): Promise<{ rows: SpeedRow[]; employeesWithoutSpeed: number; employeesWithWork: number } | null> {
  const result = await getActivityReportDataWithAttribution(activityId, from, to);
  if (!result) return null;
  const { data, attribution } = result;
  let employeesWithoutSpeed = 0;
  const rows: SpeedRow[] = [];
  for (const total of data.employeeTotals) {
    const density = attribution.byEmployee.get(total.employeeId);
    if (!density || density.durationSeconds <= 0) {
      employeesWithoutSpeed++;
      continue;
    }
    const speed = aggregateDensitySpeed([{ quantityPerRow: density.quantity, durationSeconds: density.durationSeconds }]);
    if (speed == null) {
      employeesWithoutSpeed++;
      continue;
    }
    rows.push({
      employeeId: total.employeeId,
      speed: round2(speed),
      quantityCounted: density.quantity,
      activityHours: round2(total.workSeconds / 3600),
    });
  }
  return { rows, employeesWithoutSpeed, employeesWithWork: data.employeeTotals.length };
}

// Several TVs poll the same activity and dates; share one computation for a
// short time instead of each running a full report. Age is reported to the
// TV through computedAt, so a retained figure is never presented as new.
const SPEED_CACHE_MS = 30_000;
const speedCache = new Map<string, { at: number; promise: Promise<Awaited<ReturnType<typeof computeActivitySpeedRows>>> }>();

function cachedSpeedRows(activityId: string, from: string, to: string) {
  const key = `${activityId}:${from}:${to}`;
  const now = Date.now();
  const hit = speedCache.get(key);
  if (hit && now - hit.at < SPEED_CACHE_MS) return { promise: hit.promise, computedAt: hit.at };
  const promise = computeActivitySpeedRows(activityId, from, to);
  speedCache.set(key, { at: now, promise });
  promise.catch(() => speedCache.delete(key));
  for (const [k, v] of speedCache) if (now - v.at >= SPEED_CACHE_MS) speedCache.delete(k);
  return { promise, computedAt: now };
}

export function _clearSpeedCacheForTests(): void {
  speedCache.clear();
}

export type SlideStatus = "ok" | "no_speed" | "unavailable";
// Why a slide has no ranking: the activity has no stems/plants count at all
// (never measurable), work exists but no visit has a calculable speed yet,
// or everyone with a speed is under the minimum hours.
export type NoSpeedReason = "no_density" | "not_calculable" | "below_minimum" | null;

export interface RankedEmployee {
  // Full name as shown on the ranking slide's bar ("First Last"), per the
  // Productive TV-style chart. firstName/lastInitial are kept for clients
  // built before displayName existed.
  displayName: string;
  firstName: string;
  lastInitial: string;
  speed: number;
  activityHours: number;
  quantityCounted: number;
}

export interface ActivitySlide {
  activityId: string;
  activityName: string;
  speedUnit: string | null;
  target: number | null;
  minimumActivityHours: number;
  topN: number | null;
  slideSeconds: number;
  // Bar colours (060_display_slide_colours.sql): at/above vs below target.
  atTargetColor: string;
  belowTargetColor: string;
  status: SlideStatus;
  reason: NoSpeedReason;
  notice: string | null;
  employees: RankedEmployee[];
  belowMinimumHours: number;
  employeesWithoutSpeed: number;
  computedAt: string;
}

export interface DisplaySlidesPayload {
  generatedAt: string;
  timezone: string;
  period: { week: ReportWeek; includeToday: boolean; dateStart: string; dateEnd: string; empty: boolean };
  mapSlideSeconds: number;
  slides: ActivitySlide[];
}

interface DisplayReportSettings {
  id: string;
  reportWeek: ReportWeek;
  reportIncludeToday: boolean;
  mapSlideSeconds: number;
}

// Activities (of the given ids) with any work entry — finished or still
// open — that started inside the period. Open work counts: a slide appears
// as soon as work is recorded, not only once a visit finishes.
async function activitiesWithWork(activityIds: string[], dateStart: string, dateEnd: string): Promise<Set<string>> {
  if (activityIds.length === 0) return new Set();
  const { start, end } = getRangeBoundsUtc(dateStart, dateEnd);
  const { rows } = await pool.query(
    `select distinct activity_id from time_entries
     where activity_id = any($1::uuid[]) and entry_type = 'work' and deleted_at is null
       and started_at >= $2 and started_at < $3`,
    [activityIds, start, end]
  );
  return new Set(rows.map((r) => r.activity_id as string));
}

export async function buildDisplaySlides(display: DisplayReportSettings, today: string): Promise<DisplaySlidesPayload> {
  const period = resolveReportingPeriod(display.reportWeek, display.reportIncludeToday, today);
  const base: DisplaySlidesPayload = {
    generatedAt: new Date().toISOString(),
    timezone: APP_TIMEZONE,
    period: { week: display.reportWeek, includeToday: display.reportIncludeToday, ...period },
    mapSlideSeconds: display.mapSlideSeconds,
    slides: [],
  };
  if (period.empty) return base;

  const { rows: enabled } = await pool.query(
    `select a.id, a.name, a.speed_unit, a.density_source, a.normal_speed,
            s.target_override, s.minimum_activity_hours, s.top_n, s.slide_seconds,
            s.at_target_color, s.below_target_color
     from greenhouse_display_activity_slides s
     join activities a on a.id = s.activity_id and a.is_active = true
     where s.display_id = $1 and s.send_to_tv = true
     order by a.sort_order, lower(a.name)`,
    [display.id]
  );
  if (enabled.length === 0) return base;

  const withWork = await activitiesWithWork(
    enabled.map((r) => r.id),
    period.dateStart,
    period.dateEnd
  );

  for (const a of enabled) {
    if (!withWork.has(a.id)) continue; // no work in the period: skipped entirely
    const minimumActivityHours = Number(a.minimum_activity_hours);
    const slide: ActivitySlide = {
      activityId: a.id,
      activityName: a.name,
      speedUnit: a.speed_unit,
      target: a.target_override != null ? Number(a.target_override) : a.normal_speed != null ? Number(a.normal_speed) : null,
      minimumActivityHours,
      topN: a.top_n,
      slideSeconds: a.slide_seconds,
      atTargetColor: a.at_target_color,
      belowTargetColor: a.below_target_color,
      status: "ok",
      reason: null,
      notice: null,
      employees: [],
      belowMinimumHours: 0,
      employeesWithoutSpeed: 0,
      computedAt: new Date().toISOString(),
    };

    if (!a.density_source) {
      slide.status = "no_speed";
      slide.reason = "no_density";
      slide.notice = `Work is recorded, but LabourLink doesn't calculate a speed for ${a.name}: it has no stems or plants count per row.`;
      base.slides.push(slide);
      continue;
    }

    try {
      const { promise, computedAt } = cachedSpeedRows(a.id, period.dateStart, period.dateEnd);
      const result = await promise;
      slide.computedAt = new Date(computedAt).toISOString();
      if (!result) throw new Error("activity not found");
      slide.employeesWithoutSpeed = result.employeesWithoutSpeed;
      const sorted = [...result.rows].sort((x, y) => y.speed - x.speed);
      const eligible = sorted.filter((r) => r.activityHours >= minimumActivityHours);
      slide.belowMinimumHours = sorted.length - eligible.length;
      const shown = slide.topN ? eligible.slice(0, slide.topN) : eligible;
      const names = await employeeNames(shown.map((r) => r.employeeId));
      slide.employees = shown.map((r) => ({
        displayName: names.get(r.employeeId)?.displayName ?? "",
        firstName: names.get(r.employeeId)?.firstName ?? "",
        lastInitial: names.get(r.employeeId)?.lastInitial ?? "",
        speed: r.speed,
        activityHours: r.activityHours,
        quantityCounted: r.quantityCounted,
      }));
      if (slide.employees.length === 0) {
        slide.status = "no_speed";
        slide.reason = sorted.length > 0 ? "below_minimum" : "not_calculable";
        slide.notice =
          sorted.length > 0
            ? `No one has reached the ${minimumActivityHours} h minimum yet.`
            : "Work is recorded, but no speed can be calculated yet: visits are still in progress or their rows are waiting for review.";
      }
    } catch (err) {
      console.error(`[display-slides] ${a.name} (${a.id}) failed:`, err instanceof Error ? err.message : err);
      slide.status = "unavailable";
      slide.notice = "Speed data for this activity is unavailable right now.";
    }
    base.slides.push(slide);
  }
  return base;
}

// Names for the ranking bars. The map keeps its first-name-and-initial
// redaction; ranking slides show the full display name, like Productive TV.
async function employeeNames(ids: string[]): Promise<Map<string, { displayName: string; firstName: string; lastInitial: string }>> {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query(`select id, first_name, last_name from employees where id = any($1::uuid[])`, [ids]);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        displayName: [r.first_name, r.last_name].filter(Boolean).join(" "),
        firstName: r.first_name,
        lastInitial: r.last_name ? `${String(r.last_name).charAt(0)}.` : "",
      },
    ])
  );
}
