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

When it is on, the worker adds a scheduled break within about two minutes of the window ending, if the employee's recorded work **covers all of it**. That means all of these are true:

- **Coverage:** work starts at or before the window start and continues with no gap until at or after its end. Job switches inside the window are fine. Work that is still open counts: Auto breaks doesn't wait for Finish Work or any later phone event.
- **Nothing else is in the window:**
  - no break of any kind overlaps it;
  - nothing in it was entered, corrected, completed or rolled over by anyone;
  - a supervisor hasn't deleted this break before.

**One wait.** If the employee changed jobs inside the window and the shift is still open with nothing synced from after the window, the break waits. Adding it would delete or move those in-window segments, and an offline phone may still hold an earlier Finish Work. Undoing the break would then need exactly the deleted segments. It is added as soon as the phone syncs anything from after the window, or when the shift closes (Finish Work, or the midnight cut-off). While it waits, it is listed in Breaks to review.

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
| Forgot Break, phone silent until Finish Work | Lunch added at about 13:02, while the shift is still open. |
| Forgot Break and Finish Work | Lunch added at about 13:02; the midnight cut-off closes the shift; lunch stays. |
| Lunch added while the phone was offline; its Start Break 12:10 then syncs | The tap takes the lunch over: still one 12:00–13:00 break, now the employee's. |
| Lunch added while the phone was offline; its Finish Work 12:20 then syncs | The automatic lunch is undone exactly (worked until 12:20), decided again, and listed in Breaks to review. |
| Changed job at 12:30, phone offline since | Lunch waits (see above), listed in Breaks to review. |

### Delayed phone events after an automatic break

Before a delayed phone event from before an automatic break's end is applied, that break is undone, if it can be undone exactly. Then the event applies to the day as it really was, and the break is decided again once the whole sync has been applied. This works whatever the date: the worker's today/yesterday limit only applies to adding breaks it hasn't checked.

**When it can be undone exactly:** an automatic break that covered **one** work entry only split it in two. The occurrence records the two parts (`auto_before_entry_id`, `auto_after_entry_id`), so undoing it rejoins them and deletes the break. No deleted data is needed. This holds only while:

- the part after the break is still open, and nothing from after the window has been recorded or synced;
- nobody has edited, corrected, completed or rolled over any of the three parts;
- no other record has appeared from the window start on.

**When it can't:** the break stays, and an event that contradicts it (Finish Work, or a job change inside the window, or Finish Work before it) is listed in Breaks to review with the reason. If applying that event would change work recorded after the break, it is rejected as a sync conflict instead and the day stays exactly as recorded (a supervisor's correction is never rewritten). The phone's sync carries on with its next event.

Only breaks in the event's own shift are considered: a stale event from an earlier day (another phone, an old queue) never undoes or flags today's breaks.

A late Start Break or End Break inside the window never needs review: the tap takes the break over.

The undo runs in the same transaction, under the employee lock, as the event itself, so a worker tick can't slip a break in between. While an occurrence is undone and waiting for the rest of its sync (`status = 'reversed'`), the worker leaves it alone; it picks up any left that way for more than 5 minutes.

## Breaks to review

Inputs → **Breaks to review** lists, besides breaks a cut-off closed:

- **Not added:** an Auto breaks occurrence the employee worked during but that wasn't added: work started after it began, ended before it ended, a gap, another break in the window, a protected record in it (with what kind: supervisor entry, correction, row or bin completion, rollover), waiting for the shift to end, or not checked in time after an outage. If an automatic break was undone by a delayed event, the text says so. An occurrence with no work at all, or one a supervisor deleted, isn't listed.
- **Shortened:** an employee's tapped scheduled break that starts after the window start: the shift began later, or a protected record or another break was in the way.
- **Ordinary break:** a tap inside a window that had to be recorded as an ordinary break (a protected record or another break later in the window, or the break was already recorded), or a tap for a break a supervisor had deleted.
- **Conflict:** a delayed phone event that contradicts an automatic break that couldn't be undone.

Most of these have no break record; the list says "No scheduled break recorded". **Confirming** needs Inputs access, a reason and a checkbox. It records who confirmed, when and why (`review_confirmed_*`), and nothing else: it never adds a break, changes a time or changes pay. Auto breaks stops checking a confirmed occurrence, so the supervisor's decision stands. To change the day, correct it in Inputs.

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
3. **Checks pending Auto breaks occurrences** whose window ended at least one minute ago. One not added yet is checked again on every tick until the end of the next day. After that it expires and is never added; if the employee worked during it, it is listed in Breaks to review.

**Recovery after an outage:**
- The first tick after restart catches up today and yesterday.
- A longer outage loses Auto breaks for older days; they expire, and the ones the employee worked through are listed in Breaks to review ("not checked in time").
- Delayed phone events still undo and re-decide an automatic break of any date (see above).
- Taps still work throughout, because they never depend on the worker.
- Each failure is logged as `[auto-breaks] ...` and retried on the next tick.
- `npm run auto-breaks:run` runs one tick by hand. It is safe while the server runs.

**Inspecting (read-only):**

```sql
-- Today's occurrences and why pending ones aren't added yet
select e.first_name, e.last_name, bo.name, bo.scheduled_start, bo.status, bo.auto_enabled, bo.last_check_reason, bo.review_reason
from break_occurrences bo join employees e on e.id = bo.employee_id
where bo.scheduled_date = (now() at time zone 'America/Toronto')::date
order by e.last_name, bo.scheduled_start;

-- Open review items
select e.first_name, e.last_name, bo.scheduled_date, bo.name, bo.review_reason, bo.review_detail, bo.review_flagged_at
from break_occurrences bo join employees e on e.id = bo.employee_id
where bo.review_reason is not null and bo.review_confirmed_at is null
order by bo.scheduled_start desc;

-- Employees on a scheduled break who asked to go back
select employee_id, started_at, resume_requested_at from time_entries
where break_occurrence_id is not null and ended_at is null and resume_requested_at is not null;
```

## What is irreversible

- **Discarded segments are gone for good.** These are work segments inside a scheduled window that a tap or an Auto break replaced. They are deleted, not soft-deleted, and not copied anywhere.
- **What stays:** the phone's sync receipts (`mobile_time_events`), with `time_entry_id` cleared, so a retried event still returns "duplicate". Bin scans link to those receipts, not to the segment, so they are kept too.
- **What is never deleted:** segments linked to a row or bin completion, a correction or a rollover.
- **Undoing an automatic break** deletes the automatic break row and the copy that split the employee's work, after re-pointing receipts and system corrections to the rejoined entry. Nothing a person entered is touched.
- **Kept on purpose, not deleted data:** to undo a break exactly, the occurrence keeps only the ids of the two parts of the split entry. It never keeps copies of deleted segments; the one case that would need them (job changes inside the window with the shift still open) waits instead.
- **Rollback limit:** a code rollback can't bring discarded segments back. Breaks recorded under these rules stay as recorded.
- **Weighing allocations:** changing work times on a picking job sends any confirmed shared-bin allocation for it back to review. Inputs corrections already did the same.
