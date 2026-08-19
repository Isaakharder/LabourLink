// Range-scoped per-employee attribution for confirmed bin completions — the
// carrier-scoped mirror of getActivityDensityAttribution (reportQueries.ts).
// Same two selection rules, adapted for carrier_completions instead of
// row_completions:
//
//  1. A confirmed carrier_completion counts exactly once (quantity is
//     always 1 — there is no per-completion weight/quantity column, see
//     039_carrier_completions.sql), attributed to a single employee, only
//     when *every* segment linked to it belongs to that one employee, that
//     one activity, and falls inside the selected range. A mixed completion
//     is excluded entirely rather than guessing an allocation — same
//     "exclude when not cleanly attributable" caution
//     getActivityDensityAttribution already applies.
//  2. A not-yet-completed carrier run is auto-counted only when it's the
//     *only* candidate anywhere for that carrier (checked via
//     getUnresolvedRunsForCarrier) — reused directly so this can never
//     drift from the review modal's own candidate list.
import { pool } from "../db";
import { APP_TIMEZONE, calendarDateInAppTimezone } from "./timezone";
import { getUnresolvedRunsForCarrier } from "./carrierCompletionCandidates";

export interface CarrierCompletionTotals {
  quantity: number; // count of bins — always an integer, one per completion/run
  durationSeconds: number;
  completions: number;
}

export interface CarrierCompletionAttribution {
  byEmployee: Map<string, CarrierCompletionTotals>;
  byEmployeeDay: Map<string, CarrierCompletionTotals>;
}

export async function getCarrierCompletionAttribution(
  activityId: string,
  rangeStart: Date,
  rangeEnd: Date
): Promise<CarrierCompletionAttribution> {
  const byEmployee = new Map<string, CarrierCompletionTotals>();
  const byEmployeeDay = new Map<string, CarrierCompletionTotals>();

  const addTo = (
    map: Map<string, CarrierCompletionTotals>,
    key: string,
    quantity: number,
    durationSeconds: number,
    completions: number
  ) => {
    const cur = map.get(key) ?? { quantity: 0, durationSeconds: 0, completions: 0 };
    cur.quantity += quantity;
    cur.durationSeconds += durationSeconds;
    cur.completions += completions;
    map.set(key, cur);
  };

  // Rule 1: confirmed bin completions.
  const { rows: completionRows } = await pool.query(
    `with segs as (
       select cc.id as completion_id, te.employee_id, te.activity_id,
              te.started_at, te.ended_at
       from carrier_completions cc
       join carrier_completion_segments ccs on ccs.carrier_completion_id = cc.id
       join time_entries te on te.id = ccs.time_entry_id
       where te.deleted_at is null
     )
     select completion_id,
            count(distinct employee_id) as employee_count,
            count(distinct activity_id) as activity_count,
            max(employee_id::text)::uuid as sole_employee_id,
            max(activity_id::text)::uuid as sole_activity_id,
            bool_and(started_at >= $2 and started_at < $3) as all_in_range,
            count(distinct to_char((started_at at time zone $4)::date, 'YYYY-MM-DD')) as distinct_days,
            max(to_char((started_at at time zone $4)::date, 'YYYY-MM-DD')) as sole_day,
            sum(extract(epoch from (ended_at - started_at))) as total_duration_seconds
     from segs
     group by completion_id
     having bool_or(activity_id = $1) or count(distinct activity_id) > 1`,
    [activityId, rangeStart, rangeEnd, APP_TIMEZONE]
  );
  for (const c of completionRows) {
    if (Number(c.employee_count) !== 1) continue;
    if (Number(c.activity_count) !== 1) continue;
    if (c.sole_activity_id !== activityId) continue;
    if (!c.all_in_range) continue;
    const durationSeconds = Number(c.total_duration_seconds);
    addTo(byEmployee, c.sole_employee_id, 1, durationSeconds, 1);
    if (Number(c.distinct_days) === 1) {
      addTo(byEmployeeDay, `${c.sole_employee_id}:${c.sole_day}`, 1, durationSeconds, 1);
    }
  }

  // Rule 2: unresolved (not-yet-completed) carrier runs. Bounded by distinct
  // carriers touched in this activity+range, not by employee/day.
  const { rows: candidateCarrierRows } = await pool.query(
    `select distinct te.carrier_id
     from time_entries te
     left join carrier_completion_segments ccs on ccs.time_entry_id = te.id
     where te.activity_id = $1 and te.entry_type = 'work' and te.deleted_at is null
       and te.carrier_id is not null
       and te.started_at >= $2 and te.started_at < $3
       and ccs.time_entry_id is null`,
    [activityId, rangeStart, rangeEnd]
  );
  // Resolved CONCURRENTLY, not one-carrier-at-a-time — same N+1 fix and
  // same reasoning as getActivityDensityAttribution's identical Rule 2
  // loop (reportQueries.ts): getUnresolvedRunsForCarrier calls share no
  // mutable state, and addTo's Map accumulation is commutative, so this
  // produces identical totals to the old sequential loop, just far faster
  // against a remote database.
  const candidateResults = await Promise.all(candidateCarrierRows.map((row) => getUnresolvedRunsForCarrier(row.carrier_id)));
  for (const candidates of candidateResults) {
    if (candidates.length !== 1) continue; // ambiguous (2+) — excluded, same as row completions
    const only = candidates[0];
    if (only.activityId !== activityId) continue;
    const startedAt = new Date(only.startedAt);
    const endedAt = only.endedAt ? new Date(only.endedAt) : null;
    if (!endedAt || startedAt < rangeStart || endedAt > rangeEnd) continue;
    addTo(byEmployee, only.employeeId, 1, only.durationSeconds, 0);
    const startDay = calendarDateInAppTimezone(startedAt);
    const endDay = calendarDateInAppTimezone(endedAt);
    if (startDay === endDay) {
      addTo(byEmployeeDay, `${only.employeeId}:${startDay}`, 1, only.durationSeconds, 0);
    }
  }

  return { byEmployee, byEmployeeDay };
}
