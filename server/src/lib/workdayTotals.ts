// The single authoritative "how much did this employee work today" formula
// — shared by Inputs (server/src/routes/inputs.ts's GET /daily) and Payroll
// (server/src/lib/reportQueries.ts's getPayrollReportData) so the two can
// never disagree. Previously each computed its own "sum of every work
// segment's own duration" independently, which silently excluded any
// transition gap between two activities (walking to the next row, waiting
// on a carrier, etc.) from Worked — the employee never left the workday
// (no break was recorded), so that time was never actually unaccounted for
// in reality, only in the old arithmetic. Reported bug: Reynaldo Dela Cruz,
// Aug 17 2026 — corrected work start 6:45 AM, corrected work end 7:00 PM,
// one 1:00:00 unpaid lunch, Worked showed 11:13:52 instead of 11:15:00 (a
// ~68s untracked transition gap between two activities was silently
// dropped).
//
// The fix: Worked is no longer a sum of work-entry durations. It's the
// whole workday SPAN (corrected/rounded work-end minus corrected/rounded
// work-start — whatever value is CURRENTLY stored, provenance-agnostic)
// minus only the UNPAID break time actually recorded inside it. A paid
// break is never subtracted (so it's implicitly still "Worked" — the
// employee is being compensated for that whole span either way), and any
// gap between two activities that isn't a recorded break at all is also
// never subtracted, for the same reason: this app's own state machine only
// ever has an employee in one of two states between Start Work and Finish
// Work — doing an activity, or on a break — so anything that isn't a break
// is, by construction, worked time.
//
// Per-ACTIVITY durations (an individual run's own durationSeconds, an
// Activity Report's per-activity workSeconds, PayrollActivityBreakdownRow)
// are deliberately UNCHANGED by this file — those still mean "exact time
// attributed to this one activity," and are not expected to sum to the
// workday's own Worked total when transition gaps exist. Only the WHOLE-
// WORKDAY total (Inputs' top "Worked" stat, Payroll's per-day workSeconds)
// goes through this function.
import { calendarDateInAppTimezone } from "./timezone";

export interface WorkdayBoundaryEntry {
  entryType: "work" | "break";
  startedAt: Date;
  // null only for a currently open (in-progress) entry.
  endedAt: Date | null;
  // Only meaningful for entryType 'break' — unclassified/legacy breaks
  // (is_paid null, recorded before that column existed) are bucketed as
  // unpaid, same convention server/src/routes/inputs.ts's breakMeta
  // already uses: a break must be explicitly marked paid to count as paid,
  // nothing is inferred.
  isPaid: boolean | null;
}

export interface WorkdayTotals {
  // The earliest work entry's own started_at — unchanged meaning from the
  // existing "work start is nothing but the earliest surviving work entry"
  // convention (see inputs.ts's own workStartTime).
  workStartTime: Date | null;
  // The latest entry's (work OR break — the day can end mid-break) own
  // ended_at, only when every entry that day is closed; null while the day
  // is still open (an entry somewhere has ended_at === null).
  workEndTime: Date | null;
  workedSeconds: number;
  // paidBreakSeconds + unpaidBreakSeconds (both already deduplicated/summed
  // below) — never independently re-derived.
  breakSeconds: number;
  paidBreakSeconds: number;
  // Union (merged overlapping/adjacent intervals) of every unpaid break's
  // own [startedAt, endedAt) window — the same figure subtracted from the
  // span to get workedSeconds, so two overlapping unpaid break entries (a
  // duplicate/glitch data shape, same class of issue as the Reynaldo
  // overlapping-activity bug this whole file's investigation started from)
  // are never double-subtracted, and the displayed "unpaid break" total
  // stays consistent with what Worked actually reflects.
  unpaidBreakSeconds: number;
}

const ZERO: WorkdayTotals = {
  workStartTime: null,
  workEndTime: null,
  workedSeconds: 0,
  breakSeconds: 0,
  paidBreakSeconds: 0,
  unpaidBreakSeconds: 0,
};

// Merges overlapping/adjacent [start, end) intervals (already clipped by
// the caller to the relevant span) and returns the total seconds actually
// covered, counting any overlap exactly once.
function unionSeconds(intervals: { start: number; end: number }[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = sorted[0].start;
  let curEnd = sorted[0].end;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.start <= curEnd) {
      // Overlapping or contiguous — extend the current merged interval
      // rather than starting a new one.
      if (iv.end > curEnd) curEnd = iv.end;
    } else {
      total += (curEnd - curStart) / 1000;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  total += (curEnd - curStart) / 1000;
  return total;
}

// `now` is injectable (defaults to the real current time) purely for
// deterministic tests of the still-open-day path — every real caller
// leaves it as the default.
export function computeWorkdayTotals(entries: WorkdayBoundaryEntry[], now: Date = new Date()): WorkdayTotals {
  if (entries.length === 0) return ZERO;

  const workEntries = entries.filter((e) => e.entryType === "work");
  let workStartTime: Date | null = null;
  for (const e of workEntries) {
    if (workStartTime === null || e.startedAt < workStartTime) workStartTime = e.startedAt;
  }

  const isOpen = entries.some((e) => e.endedAt === null);
  let workEndTime: Date | null = null;
  if (!isOpen) {
    workEndTime = entries[0].endedAt!;
    for (const e of entries) {
      if (e.endedAt! > workEndTime!) workEndTime = e.endedAt!;
    }
  }
  const spanEnd = workEndTime ?? now;
  // null when there's no work entry at all that day (e.g. a break recorded
  // before its surrounding work entries were ever added) — break totals
  // below must still be computed correctly in that case; only Worked
  // itself genuinely has nothing to measure without a work-anchored span.
  const workStartMs = workStartTime ? workStartTime.getTime() : null;

  // Deliberately NOT clipped to [workStartTime, spanEnd] — a break's own
  // stored (already corrected/rounded) boundaries are trusted as-is, same
  // as the pre-fix behavior that just summed each break's own duration
  // directly. Clipping to a moving `now` on a still-open day is exactly
  // the kind of subtly-wrong idea it looks like at first: work-start/end
  // rounding can legitimately round a break's boundary a few minutes past
  // the instant a raw tap happened, and a fast-running request can call
  // this before that much real wall-clock time has actually elapsed —
  // clipping would then wrongly discard part (or all) of a completely
  // legitimate, already-closed break. Breaks are only ever recorded while
  // genuinely inside a workday by construction (the mobile app has no way
  // to start one before Start Work or after Finish Work), so there's
  // nothing to guard against here that a real recorded break could
  // actually violate.
  let paidBreakSeconds = 0;
  const unpaidIntervals: { start: number; end: number }[] = [];
  for (const e of entries) {
    if (e.entryType !== "break") continue;
    const endMs = e.endedAt ? e.endedAt.getTime() : now.getTime();
    const startMs = e.startedAt.getTime();
    if (endMs <= startMs) continue;
    if (e.isPaid) {
      paidBreakSeconds += (endMs - startMs) / 1000;
    } else {
      unpaidIntervals.push({ start: startMs, end: endMs });
    }
  }
  const unpaidBreakSeconds = unionSeconds(unpaidIntervals);
  const breakSeconds = paidBreakSeconds + unpaidBreakSeconds;

  // Worked can never go negative even if recorded unpaid-break time
  // somehow exceeds the measured span (a data anomaly, not something
  // clipping should paper over — see the comment above) — floored at 0
  // rather than trusted to always come out non-negative on its own.
  const workedSeconds =
    workStartMs !== null ? Math.max(0, (spanEnd.getTime() - workStartMs) / 1000 - unpaidBreakSeconds) : 0;

  return { workStartTime, workEndTime, workedSeconds, breakSeconds, paidBreakSeconds, unpaidBreakSeconds };
}

// Groups a flat list of entries (already scoped to one employee, one date
// range) by employee + APP_TIMEZONE calendar date — the exact grain
// getPayrollReportData needs (one computeWorkdayTotals call per employee-
// day), reused rather than reimplemented so Payroll's own grouping can
// never quietly diverge from this file's own date semantics.
export function groupByEmployeeDay<T extends { employeeId: string; startedAt: Date }>(
  entries: T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const e of entries) {
    const key = `${e.employeeId}:${calendarDateInAppTimezone(e.startedAt)}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return groups;
}
