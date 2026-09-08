// Fixed-break "hour matching": a configured scheduled break (e.g. Lunch,
// 12:00 PM-1:00 PM) is authoritative — an employee's Start/End Break taps
// only CONFIRM that the scheduled break happened; they never determine its
// recorded times. A tap anywhere inside the configured [start, end) records
// the break as exactly [start, end) — a tap at 12:02 PM and another at
// 12:58 PM for a configured 12:00 PM-1:00 PM Lunch Break both produce
// 12:00 PM-1:00 PM.
//
// This replaces the previous design: two INDEPENDENT ± minutes windows
// (fixed_start_window_minutes / fixed_end_window_minutes), each compared
// against whenever the SERVER happened to process the request rather than
// the phone's own real tap time. That failed in three concrete ways this
// module fixes:
//   1. The end-side window was a second, separate decision from the
//      start-side one — a tap outside fixed_start_window_minutes never got
//      tagged to the item at all, so the end side (which only ever looked
//      at the FK already stored on the open row) had nothing to match
//      against regardless of how wide fixed_end_window_minutes was.
//   2. Matching compared against server `now()`, not the real tap — a
//      delayed offline-queue replay or a late applySyncedEvent could miss
//      a window a live tap would have matched, or resolve to the wrong
//      calendar date entirely near a midnight boundary.
//   3. There was no guarantee a given scheduled break could only be
//      recorded once per employee per date for a MANUAL (mobile-tap) match
//      — only auto-added rows had that protection (migration 010's
//      idx_time_entries_auto_break_once).
//
// Fixed-break items are always same-day: chk_break_profile_items_end_after_
// start (migration 010) requires end_time > start_time, so a break whose
// own configured schedule spans midnight is not a supported configuration.
// Given the separate, deliberately-hardened "a shift may never cross local
// midnight" invariant (midnightCutoff.ts) — which force-closes ANY open
// entry, breaks included, at exactly local midnight — an overnight-spanning
// fixed break's configured end could never actually be honored if the
// employee were still on it at midnight anyway, so allowing that
// configuration at all would just be a trap. Ordinary same-day matching
// (this module) already resolves correctly for a break scheduled close to
// end-of-day, including when a synced event is delayed until after actual
// midnight has passed server-side — see resolveStartBreakMatch's own
// comment on anchoring to the tap's own timestamp.
import { PoolClient, Pool } from "pg";
import { calendarDateInAppTimezone, parseTimeParts, zonedWallTimeToUtc } from "./timezone";

export interface FixedBreakItem {
  id: string;
  startTime: string; // "HH:MM:SS"
  endTime: string; // "HH:MM:SS"
  isPaid: boolean;
}

type Queryable = Pick<Pool | PoolClient, "query">;

// Every active fixed-break item on the employee's currently assigned break
// profile — read fresh on every call, same "whatever's live now applies, no
// historical/versioned lookup" convention as loadBreakRoundingSettings and
// its siblings in mobileTime.ts.
export async function loadActiveFixedBreakItems(db: Queryable, employeeId: string): Promise<FixedBreakItem[]> {
  const { rows } = await db.query(
    `select bpi.id, bpi.start_time, bpi.end_time, bpi.is_paid
     from employees e
     join break_profiles bp on bp.id = e.break_profile_id and bp.is_active = true
     join break_profile_items bpi
       on bpi.break_profile_id = bp.id and bpi.fixed_break = true and bpi.is_active = true
     where e.id = $1 and e.is_active = true`,
    [employeeId]
  );
  return rows.map((r) => ({ id: r.id, startTime: r.start_time, endTime: r.end_time, isPaid: r.is_paid }));
}

// The [start, end) UTC instants a fixed item's configured wall-clock times
// resolve to on one specific local calendar date.
export function computeScheduledInterval(item: FixedBreakItem, anchorDateLocal: string): { start: Date; end: Date } {
  const [y, mo, da] = anchorDateLocal.split("-").map(Number);
  const [sh, sm, ss] = parseTimeParts(item.startTime);
  const [eh, em, es] = parseTimeParts(item.endTime);
  return {
    start: zonedWallTimeToUtc(y, mo, da, sh, sm, ss),
    end: zonedWallTimeToUtc(y, mo, da, eh, em, es),
  };
}

export interface FixedBreakMatch {
  item: FixedBreakItem;
  scheduledStart: Date;
  scheduledEnd: Date;
  scheduledDateLocal: string;
}

// Decides which (if any) configured fixed break a Start Break tap belongs
// to.
//
// Containment, not proximity: the tap must fall WITHIN the break's own
// configured [start, end) — "between 12:00 PM and 1:00 PM" in the product's
// own words — rather than within some independently configured number of
// minutes of the start alone. There is no separate "window" to configure
// any more; the schedule itself IS the window.
//
// Anchored to the tap's own timestamp, never to whenever the server happens
// to process the request: `tapInstant` (the phone's own captured tap time —
// see call sites' use of resolveOriginalStartedAt) decides both which
// calendar date this is (anchorDateLocal) and whether it falls inside a
// candidate's interval.
//
// Excludes any item this employee has already used on this same local date
// (a non-deleted time_entries row already carrying that
// break_profile_item_id + scheduled_break_date) — "only one instance of
// each scheduled break may be added per employee/date." An excluded/
// already-used item simply isn't a candidate; if it was the only one that
// would have contained the tap, the caller correctly falls through to
// ordinary (non-scheduled) break handling, exactly as if nothing matched.
// A genuine concurrent double-tap that slips past this best-effort check
// anyway is caught at the database level by
// idx_time_entries_manual_scheduled_break_once (migration 052) — openEntry()
// already treats that unique-violation the same way it treats any other
// insert race (returns whatever the winner actually committed), so no
// additional locking is needed here.
//
// If more than one remaining candidate's interval contains the tap (an
// admin has configured overlapping fixed breaks — unusual, never rejected
// at configuration time, see breakProfiles.ts), the most specific
// (shortest) interval wins; ties broken by earliest start. This is a
// best-effort tiebreak for a misconfiguration, not a case any well-formed
// profile should ever actually reach.
export async function resolveStartBreakMatch(
  db: Queryable,
  employeeId: string,
  tapInstant: Date
): Promise<FixedBreakMatch | null> {
  const items = await loadActiveFixedBreakItems(db, employeeId);
  if (items.length === 0) return null;

  const anchorDateLocal = calendarDateInAppTimezone(tapInstant);

  const { rows: usedRows } = await db.query(
    `select distinct break_profile_item_id from time_entries
     where employee_id = $1 and scheduled_break_date = $2
       and break_profile_item_id = any($3::uuid[]) and deleted_at is null`,
    [employeeId, anchorDateLocal, items.map((i) => i.id)]
  );
  const usedItemIds = new Set<string>(usedRows.map((r) => r.break_profile_item_id as string));

  let best: FixedBreakMatch | null = null;
  for (const item of items) {
    if (usedItemIds.has(item.id)) continue;
    const { start, end } = computeScheduledInterval(item, anchorDateLocal);
    if (tapInstant.getTime() < start.getTime() || tapInstant.getTime() >= end.getTime()) continue;

    const durationMs = end.getTime() - start.getTime();
    const bestDurationMs = best ? best.scheduledEnd.getTime() - best.scheduledStart.getTime() : Infinity;
    if (
      !best ||
      durationMs < bestDurationMs ||
      (durationMs === bestDurationMs && start.getTime() < best.scheduledStart.getTime())
    ) {
      best = { item, scheduledStart: start, scheduledEnd: end, scheduledDateLocal: anchorDateLocal };
    }
  }
  return best;
}

// The unconditional scheduled end for a currently-open entry, if (and only
// if) it's a break that was itself matched to a fixed item at start time —
// "once a Start Break tap matches a scheduled break... End Break must use
// that same scheduled break's configured end time," with no separate
// window or re-matching step of its own. Reads ONLY the
// break_profile_item_id + scheduled_break_date already stored on this exact
// row (via the join below) — this can never resolve to a different preset
// than the one Start Break actually matched, by construction, regardless of
// how late or early End Break (or anything else that closes this break —
// see mobileTime.ts's work_start/activity_switch handlers) is tapped.
// Returns null for anything else (not a break, or a break with no fixed
// match), meaning "no override — apply ordinary break-rounding instead."
export async function resolveFixedBreakCloseBoundary(
  db: Queryable,
  openEntryId: string,
  openEntryType: "work" | "break"
): Promise<Date | null> {
  if (openEntryType !== "break") return null;
  const { rows } = await db.query(
    `select bpi.end_time, to_char(te.scheduled_break_date, 'YYYY-MM-DD') as scheduled_break_date
     from time_entries te
     join break_profile_items bpi on bpi.id = te.break_profile_item_id
     where te.id = $1`,
    [openEntryId]
  );
  const row = rows[0];
  if (!row) return null;
  const [y, mo, da] = (row.scheduled_break_date as string).split("-").map(Number);
  const [eh, em, es] = parseTimeParts(row.end_time);
  return zonedWallTimeToUtc(y, mo, da, eh, em, es);
}

// Never let a computed boundary land at or before the entry's own start —
// the same short-workday/negative-duration guard every rounding path in
// mobileTime.ts already needs (see migration 040's own incident). Two-step
// fallback: the real tap time first (still guaranteed to clear the floor in
// the overwhelming majority of cases), then one second past the floor as a
// last resort that's always strictly positive regardless of how the tap
// itself relates to it.
export function applyBreakBoundaryFloor(candidate: Date, floor: Date, fallbackTap: Date): Date {
  if (candidate.getTime() > floor.getTime()) return candidate;
  if (fallbackTap.getTime() > floor.getTime()) return fallbackTap;
  return new Date(floor.getTime() + 1000);
}
