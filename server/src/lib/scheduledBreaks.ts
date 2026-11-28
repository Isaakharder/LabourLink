// Scheduled breaks: the employee's own taps on a scheduled (fixed) break,
// and Auto breaks (breaks added for an employee who worked through one).
//
// Rules (agreed 2026-11-28):
//   1. A Start Break tap inside a scheduled fixed break's window records the
//      FULL scheduled window. Work recorded inside the window before the tap
//      is removed for good (the job active at the tap resumes at the
//      scheduled end, with its row, bin and density snapshot). The break
//      never starts before the employee's current shift began, and never
//      overwrites a supervisor-entered, corrected, completion-linked or
//      rollover-linked record, or another break (it starts after them).
//   2. The employee stays on that break until its scheduled end. End Break,
//      or choosing a job, before then only asks to resume (resume_requested_
//      at); work resumes at the scheduled end — by the next phone request,
//      the auto-breaks worker (autoBreakWorker.ts) or the midnight cut-off,
//      whichever comes first. Another Start Break before the end just
//      cancels that request. Finish Work ends the break at the tap.
//   3. Auto breaks (employees.auto_breaks_enabled): once a window has ended
//      and the employee worked continuously through all of it, the worker
//      adds the break. Never on a day or window that started before Auto
//      breaks was turned on, never across a gap, never over a supervisor's
//      record, never when the employee's own tap already recorded it, and
//      never again after a supervisor deleted it.
//   4. break_occurrences freezes each day's schedule once its window starts,
//      so later profile or employee edits can't change it.
//
// Every write here runs inside the caller's transaction with the
// per-employee lock (lockEmployeeForManualEntry) already held, so taps,
// sync retries, the worker and Inputs corrections are serialized per
// employee.
//
// Permanent removal: work segments this module discards (only ever segments
// lying inside a scheduled window, with no supervisor entry, correction,
// completion or rollover link) are DELETED, not soft-deleted, and are not
// copied anywhere. Their sync receipts (mobile_time_events) are kept, with
// time_entry_id cleared, so a phone retrying the same event still gets
// "duplicate" and nothing is re-applied.
import { randomUUID } from "crypto";
import { PoolClient } from "pg";
import { pool } from "../db";
import { resolveDensitySnapshot } from "./activitySelection";
import { lockEmployeeForManualEntry } from "./manualTimeEntries";
import { addDaysToDateStr, calendarDateInAppTimezone, parseTimeParts, zonedWallTimeToUtc } from "./timezone";

// Two entries closer than this are treated as contiguous (one closes and the
// next opens in the same transaction, so real chains match exactly).
const CONTIGUOUS_MS = 1000;

export interface Occurrence {
  id: string;
  employee_id: string;
  break_profile_item_id: string;
  scheduled_date: string;
  name: string | null;
  scheduled_start: Date;
  scheduled_end: Date;
  is_paid: boolean;
  fixed_break: boolean;
  auto_enabled: boolean;
  status: "pending" | "tapped" | "auto_added" | "expired";
  break_entry_id: string | null;
}

const OCCURRENCE_COLUMNS = `id, employee_id, break_profile_item_id, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date,
  name, scheduled_start, scheduled_end, is_paid, fixed_break, auto_enabled, status, break_entry_id`;

type Db = Pick<PoolClient, "query">;

// ---------------------------------------------------------------------------
// Occurrence snapshots
// ---------------------------------------------------------------------------

// Writes the employee's occurrences for one local date, for every active
// item of their active profile whose window has started by `now`. Settings
// edited after a window started never reach it: an item edited (or created)
// after its start, a profile assigned after it, or Auto breaks turned on
// after it, is not snapshotted with those values (the item is skipped, Auto
// breaks counts as off). Already-written occurrences are never changed.
export async function ensureOccurrences(db: Db, employeeId: string, dateStr: string, now: Date): Promise<void> {
  const { rows } = await db.query(
    `select e.is_active, e.auto_breaks_enabled, e.auto_breaks_effective_from, e.break_profile_assigned_at,
            bpi.id as item_id, bpi.name, bpi.start_time, bpi.end_time, bpi.is_paid, bpi.fixed_break, bpi.updated_at
     from employees e
     join break_profiles bp on bp.id = e.break_profile_id and bp.is_active = true
     join break_profile_items bpi on bpi.break_profile_id = bp.id and bpi.is_active = true
     where e.id = $1 and e.is_active = true
       and not exists (select 1 from break_occurrences bo
                       where bo.employee_id = e.id and bo.break_profile_item_id = bpi.id and bo.scheduled_date = $2::date)`,
    [employeeId, dateStr]
  );
  const [y, mo, d] = dateStr.split("-").map(Number);
  for (const r of rows) {
    const [sh, sm, ss] = parseTimeParts(r.start_time);
    const [eh, em, es] = parseTimeParts(r.end_time);
    const start = zonedWallTimeToUtc(y, mo, d, sh, sm, ss);
    const end = zonedWallTimeToUtc(y, mo, d, eh, em, es);
    if (start.getTime() > now.getTime()) continue; // not started: later edits still apply
    if (new Date(r.updated_at).getTime() > start.getTime()) continue; // schedule changed after it started
    if (r.break_profile_assigned_at && new Date(r.break_profile_assigned_at).getTime() > start.getTime()) continue;
    const autoEnabled =
      r.auto_breaks_enabled === true &&
      r.auto_breaks_effective_from !== null &&
      new Date(r.auto_breaks_effective_from).getTime() <= start.getTime();
    await db.query(
      `insert into break_occurrences
         (employee_id, break_profile_item_id, scheduled_date, name, scheduled_start, scheduled_end, is_paid, fixed_break, auto_enabled)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (employee_id, break_profile_item_id, scheduled_date) do nothing`,
      [employeeId, r.item_id, dateStr, r.name, start, end, r.is_paid, r.fixed_break, autoEnabled]
    );
  }
}

export async function loadOccurrence(db: Db, id: string): Promise<Occurrence | null> {
  const { rows } = await db.query(`select ${OCCURRENCE_COLUMNS} from break_occurrences where id = $1`, [id]);
  return rows[0] ?? null;
}

// The not-yet-recorded fixed-break occurrence whose window contains `tap`
// (shortest window first if a profile has overlapping items), or null. One
// already tapped or added never matches again ("one per employee and date").
async function occurrenceContaining(db: Db, employeeId: string, tap: Date, now: Date): Promise<Occurrence | null> {
  const dateStr = calendarDateInAppTimezone(tap);
  await ensureOccurrences(db, employeeId, dateStr, now);
  const { rows } = await db.query(
    `select ${OCCURRENCE_COLUMNS} from break_occurrences
     where employee_id = $1 and scheduled_date = $2::date and fixed_break and status in ('pending', 'expired')
       and scheduled_start <= $3 and scheduled_end > $3
     order by (scheduled_end - scheduled_start) asc, scheduled_start asc
     limit 1`,
    [employeeId, dateStr, tap]
  );
  return rows[0] ?? null;
}

async function supervisorRemoved(db: Db, o: Occurrence): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from break_schedule_exceptions where employee_id = $1 and break_profile_item_id = $2 and scheduled_date = $3::date`,
    [o.employee_id, o.break_profile_item_id, o.scheduled_date]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

interface Entry {
  id: string;
  entry_type: "work" | "break";
  device_id: string | null;
  activity_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  greenhouse_row_id: string | null;
  carrier_id: string | null;
  density_type: "plants" | "stems" | null;
  density_count_per_row: number | null;
  break_occurrence_id: string | null;
  auto_closed_at: Date | null;
  // Supervisor-entered, corrected by a person, or linked to a row/bin
  // completion or a midnight rollover: never moved or removed here.
  protected: boolean;
}

const ENTRY_COLUMNS = `te.id, te.entry_type, te.device_id, te.activity_id, te.started_at, te.ended_at, te.greenhouse_row_id,
  te.carrier_id, te.density_type, te.density_count_per_row, te.break_occurrence_id, te.auto_closed_at,
  (te.created_by_employee_id is not null
   or exists (select 1 from time_entry_corrections c where c.time_entry_id = te.id and c.changed_by_employee_id is not null)
   or exists (select 1 from row_completion_segments s where s.time_entry_id = te.id)
   or exists (select 1 from carrier_completion_segments s where s.time_entry_id = te.id)
   or exists (select 1 from time_entries r where r.rollover_of_entry_id = te.id)
   or te.rollover_of_entry_id is not null) as protected`;

function toEntry(r: Record<string, unknown>): Entry {
  return { ...(r as unknown as Entry), started_at: new Date(r.started_at as string), ended_at: r.ended_at ? new Date(r.ended_at as string) : null };
}

// Every non-deleted entry of the employee overlapping [from, to).
async function entriesBetween(db: Db, employeeId: string, from: Date, to: Date): Promise<Entry[]> {
  const { rows } = await db.query(
    `select ${ENTRY_COLUMNS}
     from time_entries te
     where te.employee_id = $1 and te.deleted_at is null
       and te.started_at < $3 and (te.ended_at is null or te.ended_at > $2)
     order by te.started_at asc, te.created_at asc`,
    [employeeId, from, to]
  );
  return rows.map(toEntry);
}

// The employee's open entry, row-locked.
async function lockedOpenEntry(db: Db, employeeId: string): Promise<Entry | null> {
  const { rows } = await db.query(
    `select ${ENTRY_COLUMNS}
     from time_entries te
     where te.employee_id = $1 and te.ended_at is null and te.deleted_at is null
     for update of te`,
    [employeeId]
  );
  return rows[0] ? toEntry(rows[0]) : null;
}

// Permanently removes work segments discarded by break reconciliation (see
// the header). Receipts keep their row; only the pointer is cleared.
async function discard(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(`update mobile_time_events set time_entry_id = null where time_entry_id = any($1::uuid[])`, [ids]);
  await db.query(`update break_occurrences set break_entry_id = null where break_entry_id = any($1::uuid[])`, [ids]);
  await db.query(`delete from time_entries where id = any($1::uuid[]) and entry_type = 'work'`, [ids]);
}

interface ResumeTarget {
  activityId: string;
  greenhouseRowId: string | null;
  carrierId: string | null;
  densityType: "plants" | "stems" | null;
  densityCountPerRow: number | null;
}

function resumeOf(e: Entry): ResumeTarget | null {
  if (e.entry_type !== "work" || !e.activity_id) return null;
  return {
    activityId: e.activity_id,
    greenhouseRowId: e.greenhouse_row_id,
    carrierId: e.carrier_id,
    densityType: e.density_type,
    densityCountPerRow: e.density_count_per_row,
  };
}

// ---------------------------------------------------------------------------
// Employee taps
// ---------------------------------------------------------------------------

export type TapKind = "break_start" | "break_end" | "work" | "end_day";

export interface Tap {
  employeeId: string;
  deviceId: string;
  kind: TapKind;
  idempotencyKey: string;
  at: Date; // the phone's own tap time
  // For kind "work": the validated job the employee chose.
  work?: { activityId: string; greenhouseRowId: string | null; carrierId: string | null };
}

export type TapOutcome =
  | { handled: true; entryId: string | null; note?: string }
  | { handled: false };

// Applies the scheduled-break rules to one tap, inside the caller's
// transaction (employee lock held). Returns handled: false when the tap is
// ordinary and the caller's normal path should record it.
export async function applyScheduledBreakTap(db: Db, tap: Tap, now: Date = new Date()): Promise<TapOutcome> {
  // A replay of an event that already created its break.
  if (tap.kind === "break_start") {
    const { rows } = await db.query(`select id from time_entries where idempotency_key = $1`, [tap.idempotencyKey]);
    if (rows[0]) return { handled: true, entryId: rows[0].id };
  }

  // Work already due back (the scheduled end passed before this tap).
  await materializeDueResume(db, tap.employeeId, tap.at);

  const open = await lockedOpenEntry(db, tap.employeeId);
  const occ = open?.entry_type === "break" && open.break_occurrence_id ? await loadOccurrence(db, open.break_occurrence_id) : null;

  if (open && occ) {
    // On a scheduled break.
    if (tap.kind === "end_day") return { handled: false };
    const resumable = await db.query(`select resume_activity_id from time_entries where id = $1`, [open.id]);
    // A scheduled break started without a job to go back to (never from the
    // phone): only choosing a job can end it on schedule.
    if (tap.kind === "break_end" && !resumable.rows[0]?.resume_activity_id) return { handled: false };
    if (tap.kind === "break_start") {
      if (tap.at.getTime() >= occ.scheduled_end.getTime()) return { handled: false };
      // Back on the break: cancel any earlier request to resume.
      await db.query(`update time_entries set resume_requested_at = null, actual_ended_at = null where id = $1`, [open.id]);
      return { handled: true, entryId: open.id };
    }
    if (tap.kind === "work" && tap.work) {
      const density = await resolveDensitySnapshot(db as PoolClient, tap.work.activityId, tap.work.greenhouseRowId);
      await db.query(
        `update time_entries
         set resume_activity_id = $2, resume_greenhouse_row_id = $3, resume_carrier_id = $4,
             resume_density_type = $5, resume_density_count_per_row = $6,
             resume_requested_at = coalesce(resume_requested_at, $7), actual_ended_at = coalesce(actual_ended_at, $7)
         where id = $1`,
        [open.id, tap.work.activityId, tap.work.greenhouseRowId, tap.work.carrierId, density.densityType, density.densityCountPerRow, tap.at]
      );
    } else if (tap.kind === "break_end") {
      await db.query(
        `update time_entries
         set resume_requested_at = coalesce(resume_requested_at, $2), actual_ended_at = coalesce(actual_ended_at, $2)
         where id = $1`,
        [open.id, tap.at]
      );
    }
    // Only as of the tap itself, never "now": a late offline batch may still
    // hold later taps from before the scheduled end (a job change, Finish
    // Work at 12:50) that must apply first. /me, the next event or the
    // worker resumes it once real time passes the end.
    await materializeDueResume(db, tap.employeeId, tap.at);
    return { handled: true, entryId: open.id };
  }

  if (tap.kind === "end_day" && open?.entry_type === "work" && open.started_at.getTime() > tap.at.getTime()) {
    // Finish Work tapped before the scheduled end, arriving after work was
    // already resumed at that end (an offline phone): they left from the
    // break, so the resumed work never happened.
    const { rows } = await db.query(
      `select id from time_entries
       where employee_id = $1 and entry_type = 'break' and deleted_at is null and break_occurrence_id is not null
         and resume_requested_at is not null and ended_at = $2 and started_at < $3`,
      [tap.employeeId, open.started_at, tap.at]
    );
    if (rows[0] && !open.protected) {
      await discard(db, [open.id]);
      await db.query(`update time_entries set ended_at = null where id = $1`, [rows[0].id]);
    }
    return { handled: false };
  }

  if (tap.kind === "break_end" && (!open || open.entry_type === "work")) {
    // Nothing to end: they are already back at work, or finished, and this
    // tap belongs to a scheduled break already recorded (the scheduled end
    // passed, or Auto breaks recorded it before this offline tap arrived).
    // Keep the real return time on that break; never open work from it.
    const { rows } = await db.query(
      `update time_entries set actual_ended_at = coalesce(actual_ended_at, $2)
       where employee_id = $1 and entry_type = 'break' and deleted_at is null and break_occurrence_id is not null
         and started_at <= $2 and ended_at > $2
       returning id`,
      [tap.employeeId, tap.at]
    );
    if (open) return { handled: true, entryId: open.id };
    if (rows[0]) return { handled: true, entryId: rows[0].id };
    return { handled: false };
  }

  if (tap.kind !== "break_start") return { handled: false };

  // Start Break while working (or idle).
  const covering = await db.query(
    `select id, source, break_occurrence_id from time_entries
     where employee_id = $1 and entry_type = 'break' and deleted_at is null
       and started_at <= $2 and ended_at is not null and ended_at > $2
     limit 1`,
    [tap.employeeId, tap.at]
  );
  if (covering.rows[0]) {
    // Already recorded (a late offline tap after Auto breaks, or a
    // supervisor-entered break): reconcile, never add a second break.
    const c = covering.rows[0];
    if (c.break_occurrence_id && c.source === "auto") {
      await db.query(`update time_entries set source = 'manual', actual_started_at = $2 where id = $1`, [c.id, tap.at]);
      await db.query(`update break_occurrences set status = 'tapped' where id = $1`, [c.break_occurrence_id]);
    }
    return { handled: true, entryId: c.id };
  }

  if (!open || open.entry_type !== "work") return { handled: false };
  const o = await occurrenceContaining(db, tap.employeeId, tap.at, now);
  if (!o || o.status === "tapped" || o.status === "auto_added") return { handled: false };
  if (await supervisorRemoved(db, o)) {
    return { handled: false };
  }
  return startScheduledBreak(db, tap, o, open);
}

async function startScheduledBreak(db: Db, tap: Tap, o: Occurrence, open: Entry): Promise<TapOutcome> {
  const S = o.scheduled_start.getTime();
  const T = tap.at.getTime();

  // A supervisor's entry or another break later in the window, or this
  // item already recorded today: the full window can't be recorded without
  // overwriting it, so this is an ordinary break at the tap.
  const later = await entriesBetween(db, tap.employeeId, tap.at, o.scheduled_end);
  if (later.some((e) => e.id !== open.id && (e.entry_type === "break" || e.protected))) return { handled: false };
  const sameItem = await db.query(
    `select 1 from time_entries where employee_id = $1 and break_profile_item_id = $2 and scheduled_break_date = $3::date and deleted_at is null`,
    [tap.employeeId, o.break_profile_item_id, o.scheduled_date]
  );
  if (sameItem.rows.length > 0) return { handled: false };

  // The current shift: walk back from the open entry through contiguous
  // entries. A placeholder that starts after the tap (work-start rounding
  // pushed it forward) is not part of it.
  const history = await entriesBetween(db, tap.employeeId, new Date(S - 24 * 3600 * 1000), tap.at);
  const placeholder = open.started_at.getTime() >= T ? open : null;
  let shiftStart = T;
  if (!placeholder) {
    let cur: Entry = open;
    for (;;) {
      const prev = history.find(
        (e) => e.id !== cur.id && e.ended_at && Math.abs(e.ended_at.getTime() - cur.started_at.getTime()) <= CONTIGUOUS_MS
      );
      if (!prev) break;
      cur = prev;
    }
    shiftStart = cur.started_at.getTime();
  }

  // Never before the shift began, nor over a protected record or a break.
  let start = Math.max(S, shiftStart);
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of history) {
      if (e.started_at.getTime() >= T || !e.ended_at || e.ended_at.getTime() <= start) continue;
      if (e.entry_type === "break" || e.protected) {
        if (e.ended_at.getTime() > start) {
          start = Math.min(T, e.ended_at.getTime());
          changed = true;
        }
      }
    }
  }
  if (open.protected && open.started_at.getTime() >= start && !placeholder) start = T;

  // Trim the segment running into the window, remove the ones inside it.
  const toDiscard: string[] = [];
  const work = history.filter((e) => e.entry_type === "work" && !e.protected && e.id !== open.id);
  for (const e of work) {
    if (!e.ended_at || e.ended_at.getTime() <= start) continue;
    if (e.started_at.getTime() < start) {
      await db.query(`update time_entries set ended_at = $2 where id = $1`, [e.id, new Date(start)]);
    } else {
      toDiscard.push(e.id);
    }
  }
  if (placeholder || open.started_at.getTime() >= start) toDiscard.push(open.id);
  else await db.query(`update time_entries set ended_at = $2 where id = $1`, [open.id, new Date(start)]);
  await discard(db, toDiscard);

  const resume = resumeOf(open);
  const { rows } = await db.query(
    `insert into time_entries
       (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, actual_started_at,
        break_profile_item_id, scheduled_break_date, source, is_paid, break_occurrence_id,
        resume_activity_id, resume_greenhouse_row_id, resume_carrier_id, resume_density_type, resume_density_count_per_row)
     values ($1, $2, 'break', null, $3, $4, $5, $6, $7, 'manual', $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [
      tap.employeeId,
      tap.deviceId,
      tap.idempotencyKey,
      new Date(start),
      tap.at,
      o.break_profile_item_id,
      o.scheduled_date,
      o.is_paid,
      o.id,
      resume?.activityId ?? null,
      resume?.greenhouseRowId ?? null,
      resume?.carrierId ?? null,
      resume?.densityType ?? null,
      resume?.densityCountPerRow ?? null,
    ]
  );
  await db.query(`update break_occurrences set status = 'tapped', break_entry_id = $2, resolved_at = now() where id = $1`, [o.id, rows[0].id]);
  return { handled: true, entryId: rows[0].id };
}

// ---------------------------------------------------------------------------
// Resuming work at the scheduled end
// ---------------------------------------------------------------------------

// If the employee is on a scheduled break whose end is at or before `upTo`
// and they asked to resume, ends the break at the scheduled end and opens
// the resume job there. Returns true when it did. Caller holds the lock.
export async function materializeDueResume(db: Db, employeeId: string, upTo: Date): Promise<boolean> {
  const { rows } = await db.query(
    `select te.id, te.device_id, te.started_at, te.resume_requested_at, te.resume_activity_id, te.resume_greenhouse_row_id,
            te.resume_carrier_id, te.resume_density_type, te.resume_density_count_per_row, bo.scheduled_end
     from time_entries te
     join break_occurrences bo on bo.id = te.break_occurrence_id
     where te.employee_id = $1 and te.entry_type = 'break' and te.ended_at is null and te.deleted_at is null
       and te.resume_requested_at is not null and te.resume_activity_id is not null and bo.scheduled_end <= $2
     for update of te`,
    [employeeId, upTo]
  );
  const b = rows[0];
  if (!b) return false;
  const end = new Date(b.scheduled_end);
  await db.query(`update time_entries set ended_at = $2 where id = $1`, [b.id, end]);
  await db.query(
    `insert into time_entries
       (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, actual_started_at,
        greenhouse_row_id, carrier_id, density_type, density_count_per_row, source)
     values ($1, $2, 'work', $3, $4, $5, $6, $7, $8, $9, $10, 'manual')`,
    [
      employeeId,
      b.device_id,
      b.resume_activity_id,
      randomUUID(),
      end,
      b.resume_requested_at,
      b.resume_greenhouse_row_id,
      b.resume_carrier_id,
      b.resume_density_type,
      b.resume_density_count_per_row,
    ]
  );
  return true;
}

// Own transaction + lock — for callers outside one (/me, the worker).
export async function materializeDueResumeForEmployee(employeeId: string, upTo: Date = new Date()): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockEmployeeForManualEntry(client, employeeId);
    const done = await materializeDueResume(client, employeeId, upTo);
    await client.query("commit");
    return done;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// What the phone needs to show while the employee is on a scheduled break.
export async function scheduledBreakStatus(db: Db, breakEntryId: string): Promise<null | {
  name: string | null;
  startsAt: string;
  endsAt: string;
  isPaid: boolean;
  resumeRequested: boolean;
  resume: { activityId: string; activityName: string; row: { id: string; label: string } | null; carrier: { id: string; name: string } | null } | null;
}> {
  const { rows } = await db.query(
    `select bo.name, bo.scheduled_start, bo.scheduled_end, bo.is_paid, te.resume_requested_at,
            te.resume_activity_id, a.name as activity_name,
            te.resume_greenhouse_row_id, gr.row_number, gp.name as phase_name,
            te.resume_carrier_id, c.name as carrier_name
     from time_entries te
     join break_occurrences bo on bo.id = te.break_occurrence_id
     left join activities a on a.id = te.resume_activity_id
     left join greenhouse_rows gr on gr.id = te.resume_greenhouse_row_id
     left join greenhouse_phases gp on gp.id = gr.phase_id
     left join carriers c on c.id = te.resume_carrier_id
     where te.id = $1`,
    [breakEntryId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    name: r.name,
    startsAt: new Date(r.scheduled_start).toISOString(),
    endsAt: new Date(r.scheduled_end).toISOString(),
    isPaid: r.is_paid,
    resumeRequested: r.resume_requested_at !== null,
    resume: r.resume_activity_id
      ? {
          activityId: r.resume_activity_id,
          activityName: r.activity_name,
          row: r.resume_greenhouse_row_id ? { id: r.resume_greenhouse_row_id, label: `${r.phase_name} · Row ${r.row_number}` } : null,
          carrier: r.resume_carrier_id ? { id: r.resume_carrier_id, name: r.carrier_name } : null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Auto breaks
// ---------------------------------------------------------------------------

export type AutoCheck =
  | { added: true; breakEntryId: string }
  | { added: false; reason: string; final: boolean };

// Decides one pending Auto breaks occurrence (window ended), inside the
// caller's transaction with the employee lock held. Adds the break only
// when the employee's work covers the WHOLE window continuously:
//   - work must start at or before the window start and continue, with no
//     gap, until at or after its end (job switches inside are fine);
//   - the end must be known: the covering work ended at or after the window
//     end (not by a system cut-off), or a later phone event already synced
//     (so no queued offline event can still say they left);
//   - no break of any kind overlaps the window, nothing in it was entered,
//     corrected, completed or rolled over by anyone, and no supervisor
//     deleted this break before.
export async function checkAutoOccurrence(db: Db, o: Occurrence): Promise<AutoCheck> {
  const S = o.scheduled_start.getTime();
  const E = o.scheduled_end.getTime();
  if (await supervisorRemoved(db, o)) return { added: false, reason: "supervisor_removed", final: true };

  const inWindow = await entriesBetween(db, o.employee_id, o.scheduled_start, o.scheduled_end);
  if (inWindow.some((e) => e.entry_type === "break")) return { added: false, reason: "existing_break", final: false };
  const work = inWindow.filter((e) => e.entry_type === "work");
  if (work.length === 0) return { added: false, reason: "no_work", final: false };
  if (work[0].started_at.getTime() > S) return { added: false, reason: "started_after_window_start", final: false };
  for (let i = 1; i < work.length; i++) {
    const prevEnd = work[i - 1].ended_at;
    if (!prevEnd || Math.abs(work[i].started_at.getTime() - prevEnd.getTime()) > CONTIGUOUS_MS) {
      return { added: false, reason: "gap_in_work", final: false };
    }
  }
  const last = work[work.length - 1];
  if (last.ended_at && last.ended_at.getTime() < E) return { added: false, reason: "ended_before_window_end", final: false };
  if (work.some((e) => e.protected)) return { added: false, reason: "supervisor_or_linked_record", final: false };

  const endKnown =
    (last.ended_at !== null && last.auto_closed_at === null && !(await closedByMidnightCutoff(db, last.id))) ||
    (
      await db.query(
        `select 1 from mobile_time_events where employee_id = $1 and processing_status = 'accepted' and occurred_at_utc >= $2 limit 1`,
        [o.employee_id, o.scheduled_end]
      )
    ).rows.length > 0;
  if (!endKnown) return { added: false, reason: "awaiting_later_activity", final: false };

  // Trim / move / remove the work around the window.
  const toDiscard: string[] = [];
  const first = work[0];
  if (work.length === 1) {
    const w = first;
    const continues = w.ended_at === null || w.ended_at.getTime() > E;
    if (w.started_at.getTime() < S) {
      await db.query(`update time_entries set ended_at = $2 where id = $1`, [w.id, o.scheduled_start]);
      if (continues) {
        await db.query(
          `insert into time_entries
             (employee_id, device_id, entry_type, activity_id, started_at, ended_at, idempotency_key,
              greenhouse_row_id, carrier_id, density_type, density_count_per_row, source)
           values ($1, $2, 'work', $3, $4, $5, $6, $7, $8, $9, $10, 'break_reconciliation')`,
          [o.employee_id, w.device_id, w.activity_id, o.scheduled_end, w.ended_at, randomUUID(), w.greenhouse_row_id, w.carrier_id, w.density_type, w.density_count_per_row]
        );
      }
    } else if (continues) {
      await db.query(`update time_entries set started_at = $2 where id = $1`, [w.id, o.scheduled_end]);
    } else {
      toDiscard.push(w.id);
    }
  } else {
    if (first.started_at.getTime() < S) await db.query(`update time_entries set ended_at = $2 where id = $1`, [first.id, o.scheduled_start]);
    else toDiscard.push(first.id);
    for (const w of work.slice(1, -1)) toDiscard.push(w.id);
    if (last.ended_at === null || last.ended_at.getTime() > E) await db.query(`update time_entries set started_at = $2 where id = $1`, [last.id, o.scheduled_end]);
    else toDiscard.push(last.id);
  }
  await discard(db, toDiscard);

  const { rows } = await db.query(
    `insert into time_entries
       (employee_id, device_id, entry_type, activity_id, started_at, ended_at, idempotency_key,
        break_profile_item_id, scheduled_break_date, source, is_paid, break_occurrence_id)
     values ($1, $2, 'break', null, $3, $4, $5, $6, $7, 'auto', $8, $9)
     returning id`,
    [o.employee_id, first.device_id, o.scheduled_start, o.scheduled_end, randomUUID(), o.break_profile_item_id, o.scheduled_date, o.is_paid, o.id]
  );
  return { added: true, breakEntryId: rows[0].id };
}

async function closedByMidnightCutoff(db: Db, entryId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from time_entry_corrections where time_entry_id = $1 and reason = 'midnight_cutoff' limit 1`,
    [entryId]
  );
  return rows.length > 0;
}

export interface AutoBreakTickResult {
  snapshotted: number;
  resumed: number;
  added: number;
  waiting: number;
  expired: number;
  failures: number;
}

// One pass of the auto-breaks worker (autoBreakWorker.ts). Safe to run
// repeatedly or concurrently with taps: every decision is per employee,
// under the employee lock, and idempotent.
//   - snapshots occurrences for today and yesterday (local), so a short
//     outage recovers yesterday's late windows too;
//   - resumes work for employees whose scheduled break ended;
//   - checks pending Auto breaks occurrences whose window ended at least
//     `graceMs` ago; ones from before yesterday are expired, never added.
export async function runAutoBreakTick(now: Date = new Date(), graceMs = 60 * 1000): Promise<AutoBreakTickResult> {
  const result: AutoBreakTickResult = { snapshotted: 0, resumed: 0, added: 0, waiting: 0, expired: 0, failures: 0 };
  const today = calendarDateInAppTimezone(now);
  const yesterday = addDaysToDateStr(today, -1);

  const { rows: emps } = await pool.query(
    `select e.id from employees e join break_profiles bp on bp.id = e.break_profile_id and bp.is_active where e.is_active`
  );
  for (const e of emps) {
    try {
      const before = await pool.query(`select count(*)::int as n from break_occurrences where employee_id = $1 and scheduled_date >= $2::date`, [e.id, yesterday]);
      await ensureOccurrences(pool, e.id, yesterday, now);
      await ensureOccurrences(pool, e.id, today, now);
      const after = await pool.query(`select count(*)::int as n from break_occurrences where employee_id = $1 and scheduled_date >= $2::date`, [e.id, yesterday]);
      result.snapshotted += after.rows[0].n - before.rows[0].n;
    } catch (err) {
      result.failures++;
      console.error(`[auto-breaks] snapshot failed employee=${e.id}:`, err);
    }
  }

  const { rows: due } = await pool.query(
    `select distinct te.employee_id from time_entries te join break_occurrences bo on bo.id = te.break_occurrence_id
     where te.ended_at is null and te.deleted_at is null and te.resume_requested_at is not null and bo.scheduled_end <= $1`,
    [now]
  );
  for (const r of due) {
    try {
      if (await materializeDueResumeForEmployee(r.employee_id, now)) result.resumed++;
    } catch (err) {
      result.failures++;
      console.error(`[auto-breaks] resume failed employee=${r.employee_id}:`, err);
    }
  }

  const expiredRes = await pool.query(
    `update break_occurrences set status = 'expired', resolved_at = now(),
            last_check_reason = coalesce(last_check_reason, 'not_checked') || ' (recovery window passed)'
     where status = 'pending' and scheduled_date < $1::date`,
    [yesterday]
  );
  result.expired += expiredRes.rowCount ?? 0;

  const { rows: pending } = await pool.query(
    `select ${OCCURRENCE_COLUMNS} from break_occurrences
     where status = 'pending' and auto_enabled and scheduled_end <= $1 and scheduled_date >= $2::date
     order by scheduled_end asc`,
    [new Date(now.getTime() - graceMs), yesterday]
  );
  for (const o of pending as Occurrence[]) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await lockEmployeeForManualEntry(client, o.employee_id);
      const fresh = await client.query(`select status from break_occurrences where id = $1 for update`, [o.id]);
      if (fresh.rows[0]?.status !== "pending") {
        await client.query("commit");
        continue;
      }
      await materializeDueResume(client, o.employee_id, now);
      const outcome = await checkAutoOccurrence(client, { ...o, scheduled_start: new Date(o.scheduled_start), scheduled_end: new Date(o.scheduled_end) });
      if (outcome.added) {
        await client.query(
          `update break_occurrences set status = 'auto_added', break_entry_id = $2, resolved_at = now(), last_check_reason = null, last_checked_at = now() where id = $1`,
          [o.id, outcome.breakEntryId]
        );
        result.added++;
      } else {
        await client.query(
          `update break_occurrences set last_check_reason = $2, last_checked_at = now(),
                  status = case when $3 then 'expired' else status end,
                  resolved_at = case when $3 then now() else resolved_at end
           where id = $1`,
          [o.id, outcome.reason, outcome.final]
        );
        if (outcome.final) result.expired++;
        else result.waiting++;
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      result.failures++;
      console.error(`[auto-breaks] check failed occurrence=${o.id}:`, err);
    } finally {
      client.release();
    }
  }
  return result;
}
