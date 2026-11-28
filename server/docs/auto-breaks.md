# Scheduled breaks and Auto breaks: rules, operation and rollout

The rules are in `server/src/lib/scheduledBreaks.ts`, the worker in `server/src/lib/autoBreakWorker.ts`, and the schema in `migrations/079_employee_auto_breaks.sql`.

## The rules

**Employee taps on a scheduled (fixed) break**

- A Start Break tap inside a scheduled window records the **whole window**. For lunch 12:00–13:00, taps at 12:10 and 12:50 record 12:00–13:00. The real tap times are kept in `actual_started_at` and `actual_ended_at`.
- **Work inside the window before the tap is removed permanently.** The segment running into the window is trimmed to end at 12:00. The job active at the tap, with its row, bin and density snapshot, resumes at the scheduled end.
- **The break never starts before the employee's shift began.** A late arrival at 12:30 who taps Start Break gets a break starting 12:30.
- **The break never starts over another record.** It starts after any record a supervisor entered, corrected, linked to a row or bin completion, or rolled over at midnight, and after any other break.
- **Back early:**
  - End Break before 13:00 keeps the employee on the break until 13:00. The server stores the request and the phone shows "Back to Picking at 1:00 PM". Work resumes at 13:00.
  - Choosing a job before 13:00 changes the job that resumes.
  - Another Start Break before 13:00 is the same break; it cancels the resume.
  - Finish Work ends the break at the tap.
- **A tap outside every window** is an ordinary break at its real times, as before.

**Auto breaks**

Auto breaks is set per employee on Add/Edit Employee. It is off by default.

When it is on, the worker adds a scheduled break only once that window has ended and the employee **worked continuously through all of it**. That means all of these are true:

- **Coverage:** work starts at or before the window start and continues with no gap until at or after its end. Job switches inside the window are fine.
- **The end is known:** the covering work ended at or after the window end without a system cut-off closing it, or a later phone event has already synced. An offline phone may still hold "left at 12:20".
- **Nothing else is in the window:**
  - no break of any kind overlaps it;
  - nothing in it was entered, corrected, completed or rolled over by anyone;
  - a supervisor hasn't deleted this break before.

Each scheduled break is decided on its own. Tapping the morning break never stops lunch from being added.

Examples for lunch 12:00–13:00:

| Day | Result |
|---|---|
| Works 07:00–16:30 | Lunch added. |
| Starts 12:20 | No lunch; nothing deducted for 12:20–13:00. |
| Finishes 12:20 | No lunch. |
| Starts 12:00 (or 11:50, rounded to 12:00) | Lunch added; work starts at 13:00. |
| Leaves 12:20, back 12:35 | No lunch (gap). |
| A supervisor's entry or an Inputs break in the window | No lunch; their record is untouched. |
| Taps lunch themselves | Their tap is the lunch; it is not added again. |
| Phone offline at lunch, syncs at 15:00 | Decided once the later events arrive. If Auto breaks already added lunch, the late taps update that break (they never add a second one). |

## No historical rewriting

- **Occurrences are frozen.** `break_occurrences` stores each employee's scheduled breaks per day, written once a window starts: start, end, paid, and whether Auto breaks applied. Later profile or employee edits can't change it.
- **Late edits don't apply.** A window whose item was edited (or created), or whose profile was assigned, after it started never takes those values. A late tap for it is an ordinary break.
- **Auto breaks is prospective.** Turning it on sets `auto_breaks_effective_from` to that moment. Only windows starting later qualify, so earlier windows and days are never backfilled.
- **Reading never writes.** Opening Inputs, for any date, writes nothing. Neither the midnight cut-off nor automatic breaks run there any more.
- **Supervisor deletions stick.** A break deleted in Inputs is never re-added automatically. A late employee tap for it records the real tap times, not the scheduled window.

## Payroll

From `payroll_settings.unpaid_break_span_clip_from` onwards, Worked deducts only the part of an unpaid break that lies inside the work span. The span runs from the first work start to the day's end, and the end is only clipped once the day is closed. Overlapping unpaid breaks are counted once, as before.

Migration 079 sets this date to the day it runs, so past payroll stays the same after deploy. In production on 2026-11-28, 4 earlier days would have changed by 15 minutes each.

To apply the rule to earlier days later, which changes those days' Worked figures:

```sql
update payroll_settings set unpaid_break_span_clip_from = '2026-08-01', updated_at = now();
```

## The worker

The worker runs inside the API server every 60 seconds; set `AUTO_BREAKS_WORKER=off` to disable it. A session advisory lock lets only one server process run a tick at a time, which matters while Railway overlaps two instances during a deploy.

Each tick does three things:

1. **Writes occurrences** for today and yesterday (Toronto time), for windows that have started.
2. **Resumes work** for employees whose scheduled break ended after they tapped End Break early. Every phone request, the end of every sync batch and the midnight cut-off do this too.
3. **Checks pending Auto breaks occurrences** whose window ended at least one minute ago. Occurrences waiting for evidence are checked again on every tick until the end of the next day. After that they expire and are never added.

**Recovery after an outage:**
- The first tick after restart catches up today and yesterday.
- A longer outage loses Auto breaks for older days; they expire.
- Taps still work throughout, because they never depend on the worker.
- Each failure is logged as `[auto-breaks] ...` and retried on the next tick.
- `npm run auto-breaks:run` runs one tick by hand. It is safe while the server runs.

**Inspecting (read-only):**

```sql
-- Today's occurrences and why pending ones aren't added yet
select e.first_name, e.last_name, bo.name, bo.scheduled_start, bo.status, bo.auto_enabled, bo.last_check_reason
from break_occurrences bo join employees e on e.id = bo.employee_id
where bo.scheduled_date = (now() at time zone 'America/Toronto')::date
order by e.last_name, bo.scheduled_start;

-- Employees on a scheduled break who asked to go back
select employee_id, started_at, resume_requested_at from time_entries
where break_occurrence_id is not null and ended_at is null and resume_requested_at is not null;
```

## What is irreversible

- **Discarded segments are gone for good.** These are work segments inside a scheduled window that a tap or an Auto break replaced. They are deleted, not soft-deleted, and not copied anywhere.
- **What stays:** the phone's sync receipts (`mobile_time_events`), with `time_entry_id` cleared, so a retried event still returns "duplicate". Bin scans link to those receipts, not to the segment, so they are kept too.
- **What is never deleted:** segments linked to a row or bin completion, a correction or a rollover.
- **Rollback limit:** a code rollback can't bring discarded segments back. Breaks recorded under these rules stay as recorded.
- **Weighing allocations:** changing work times on a picking job sends any confirmed shared-bin allocation for it back to review. Inputs corrections already did the same.
