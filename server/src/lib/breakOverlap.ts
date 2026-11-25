// Activity time never includes time the same employee was on a recorded
// break.
//
// Breaks are their own time_entries rows, so normally a work segment and a
// break never overlap. Some recorded data does overlap, though: in
// production by November 2026, about 19 hours of work overlapped 135
// ordinary breaks (1 hour or less). Before this helper, report Activity
// Hours and every speed denominator counted that time twice: once as break
// and once as activity work.
//
// Here, the overlapping part of a work segment is simply not counted as
// activity time. The rows themselves are never changed, and Payroll (span
// minus unpaid breaks, workdayTotals.ts) is not touched: payroll already
// counts an unpaid break once, whatever work overlaps it.
//
// Every break counts, paid or unpaid: a paid break is still not time spent
// on the activity.
//
// Except a break the employee never ended. A break that the system closed
// at the end of the day (the midnight cut-off, midnightCutoff.ts, or the
// 3-day backstop, dailyCutoff.ts) is no evidence the employee was on break
// all that time. In production, 4 such breaks (up to 14.5 hours long)
// overlapped 60 hours of work entries the employee kept recording. There the
// break is the doubtful record, so it is never subtracted from work: the
// overlap stays as recorded and needs review in Inputs.
import { pool } from "../db";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "./timezone";

// True when the break's end was set by an end-of-day cut-off, not by the
// employee: auto_closed_at is set (dailyCutoff.ts), or it ends exactly at
// the end of the local day it started on (midnightCutoff.ts), or at 23:59:59
// that day (dailyCutoff.ts).
export function isSystemClosedBreak(startedAt: Date, endedAt: Date, autoClosedAt: Date | null): boolean {
  if (autoClosedAt) return true;
  const dayEnd = getDayBoundsUtc(calendarDateInAppTimezone(startedAt)).end.getTime();
  const end = endedAt.getTime();
  return end === dayEnd || end === dayEnd - 1000;
}

export interface TimeInterval {
  startedAt: Date;
  endedAt: Date;
}

// Sorted, non-overlapping [start, end) intervals in epoch ms.
export type MergedBreaks = { start: number; end: number }[];

export function mergeBreakIntervals(intervals: TimeInterval[]): MergedBreaks {
  const sorted = intervals
    .map((i) => ({ start: i.startedAt.getTime(), end: i.endedAt.getTime() }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const merged: MergedBreaks = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

// The parts of `segment` not covered by any break: zero, one or several
// pieces, in order. A segment untouched by breaks comes back as itself.
export function subtractBreaks(segment: TimeInterval, breaks: MergedBreaks | undefined): TimeInterval[] {
  const s = segment.startedAt.getTime();
  const e = segment.endedAt.getTime();
  if (!breaks || breaks.length === 0 || e <= s) return e > s ? [segment] : [];
  const pieces: TimeInterval[] = [];
  let cursor = s;
  for (const b of breaks) {
    if (b.end <= cursor) continue;
    if (b.start >= e) break;
    if (b.start > cursor) pieces.push({ startedAt: new Date(cursor), endedAt: new Date(b.start) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= e) break;
  }
  if (cursor < e) {
    if (cursor === s) return [segment];
    pieces.push({ startedAt: new Date(cursor), endedAt: new Date(e) });
  }
  return pieces;
}

export function secondsOutsideBreaks(segment: TimeInterval, breaks: MergedBreaks | undefined): number {
  return subtractBreaks(segment, breaks).reduce((sum, p) => sum + (p.endedAt.getTime() - p.startedAt.getTime()) / 1000, 0);
}

// One query: every finished, non-deleted break of these employees that
// overlaps [from, to), merged per employee. System-closed breaks are left
// out (see isSystemClosedBreak).
export async function fetchMergedBreaksByEmployee(employeeIds: string[], from: Date, to: Date): Promise<Map<string, MergedBreaks>> {
  const out = new Map<string, MergedBreaks>();
  if (!employeeIds.length || to <= from) return out;
  const { rows } = await pool.query<{ employee_id: string; started_at: Date; ended_at: Date; auto_closed_at: Date | null }>(
    `select employee_id, started_at, ended_at, auto_closed_at
     from time_entries
     where entry_type = 'break' and deleted_at is null and ended_at is not null
       and employee_id = any($1::uuid[]) and started_at < $3 and ended_at > $2`,
    [[...new Set(employeeIds)], from, to]
  );
  const raw = new Map<string, TimeInterval[]>();
  for (const r of rows) {
    if (isSystemClosedBreak(r.started_at, r.ended_at, r.auto_closed_at)) continue;
    const list = raw.get(r.employee_id) ?? [];
    list.push({ startedAt: r.started_at, endedAt: r.ended_at });
    raw.set(r.employee_id, list);
  }
  for (const [employeeId, list] of raw) out.set(employeeId, mergeBreakIntervals(list));
  return out;
}
