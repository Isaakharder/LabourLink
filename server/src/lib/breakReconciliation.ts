// Server-side reconciliation for auto-added scheduled breaks. Reuses
// time_entries directly (no parallel break-recording system): when an
// employee works straight through an auto_add scheduled break without
// pressing Break, this splits the covering work entry into
// before/break/after rows using the exact scheduled start/end. The "after"
// row reuses the same activity_id and starts exactly where the break ends,
// which is what keeps it in the same job chain as far as
// accumulateChainSeconds() (mobileTime.ts) and groupIntoActivityRuns()
// (activityRuns.ts) are concerned — both infer chain continuity purely from
// an exact started_at/ended_at boundary match, and neither needed any
// changes to support this.
import { randomUUID } from "crypto";
import { pool } from "../db";
import { parseTimeParts, zonedWallTimeToUtc } from "./timezone";

interface AutoAddItem {
  id: string;
  start_time: string; // "HH:MM:SS", as returned by pg for a `time` column
  end_time: string;
  is_paid: boolean;
}

export async function reconcileEmployeeBreaks(employeeId: string, dateStr: string): Promise<void> {
  // TEMPORARY — End Work ~1min delay investigation. Elapsed-time-only, no
  // secrets. Remove once the slow hop is identified.
  const __t0 = Date.now();
  const client = await pool.connect();
  console.log(`[timing] reconcileEmployeeBreaks pool.connect(): ${Date.now() - __t0}ms`);
  try {
    await client.query("begin");

    const empRes = await client.query(
      `select is_active, break_profile_id from employees where id = $1`,
      [employeeId]
    );
    const emp = empRes.rows[0];
    if (!emp || !emp.is_active || !emp.break_profile_id) {
      await client.query("commit");
      return;
    }

    const profileRes = await client.query(`select id from break_profiles where id = $1 and is_active = true`, [
      emp.break_profile_id,
    ]);
    if (!profileRes.rows[0]) {
      await client.query("commit");
      return;
    }

    const itemsRes = await client.query<AutoAddItem>(
      `select id, start_time, end_time, is_paid
       from break_profile_items
       where break_profile_id = $1 and auto_add = true and is_active = true
       order by start_time asc`,
      [emp.break_profile_id]
    );

    const [y, mo, d] = dateStr.split("-").map(Number);
    const now = Date.now();

    let savepointIndex = 0;
    for (const item of itemsRes.rows) {
      const [sh, sm, ss] = parseTimeParts(item.start_time);
      const [eh, em, es] = parseTimeParts(item.end_time);
      const scheduledStart = zonedWallTimeToUtc(y, mo, d, sh, sm, ss);
      const scheduledEnd = zonedWallTimeToUtc(y, mo, d, eh, em, es);

      // The scheduled time must have fully passed.
      if (scheduledEnd.getTime() > now) continue;

      // A supervisor deleted a previously auto-added break for this exact
      // item/date via the Inputs page — respect that and never re-add it.
      // Without this check, reconciliation would just recreate the break on
      // the very next status fetch or Inputs load (it re-derives from the
      // schedule and the covering work entry every time, neither of which
      // a deletion changes), making the deletion pointless.
      const suppressed = await client.query(
        `select id from break_schedule_exceptions
         where employee_id = $1 and break_profile_item_id = $2 and scheduled_date = $3
         limit 1`,
        [employeeId, item.id, dateStr]
      );
      if (suppressed.rows[0]) continue;

      // Already recorded for this profile item/date, whether by a prior
      // auto-add pass or a manual fixed-match — either way, never add again.
      const already = await client.query(
        `select id from time_entries
         where employee_id = $1 and break_profile_item_id = $2 and scheduled_break_date = $3
           and deleted_at is null
         limit 1`,
        [employeeId, item.id, dateStr]
      );
      if (already.rows[0]) continue;

      // Any break at all (matched to this item or not) already overlapping
      // the scheduled window — don't double up on top of it.
      const overlapping = await client.query(
        `select id from time_entries
         where employee_id = $1 and entry_type = 'break' and deleted_at is null
           and started_at < $2 and (ended_at is null or ended_at > $3)
         limit 1`,
        [employeeId, scheduledEnd, scheduledStart]
      );
      if (overlapping.rows[0]) continue;

      // A single work entry must fully cover the scheduled window — partial
      // coverage (started mid-window, or ended before the window closed) is
      // deliberately not auto-added; see plan decision on partial coverage.
      const workRes = await client.query(
        `select id, device_id, activity_id, started_at, ended_at, greenhouse_row_id, carrier_id,
                density_type, density_count_per_row
         from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and started_at <= $2 and (ended_at is null or ended_at >= $3)
         order by started_at desc
         limit 1`,
        [employeeId, scheduledStart, scheduledEnd]
      );
      const w = workRes.rows[0];
      if (!w) continue;

      const workStart = new Date(w.started_at);
      const workEnd: Date | null = w.ended_at ? new Date(w.ended_at) : null;
      // Degenerate boundary case (work started at the exact scheduled break
      // start) — nothing to split off as a "before" segment; skip this pass
      // rather than write a zero-length row.
      if (workStart.getTime() === scheduledStart.getTime()) continue;

      const savepoint = `break_recon_${savepointIndex++}`;
      await client.query(`savepoint ${savepoint}`);
      try {
        // Converts the original work row in place into the "before" segment
        // — reused id/device_id/activity_id preserve any existing FK
        // references into it.
        await client.query(`update time_entries set ended_at = $1 where id = $2`, [scheduledStart, w.id]);

        await client.query(
          `insert into time_entries
             (employee_id, device_id, entry_type, activity_id, started_at, ended_at,
              idempotency_key, break_profile_item_id, scheduled_break_date, source, is_paid)
           values ($1, $2, 'break', null, $3, $4, $5, $6, $7, 'auto', $8)`,
          [employeeId, w.device_id, scheduledStart, scheduledEnd, randomUUID(), item.id, dateStr, item.is_paid]
        );

        // Reopen/continue work after the break only if there's actually
        // time left to account for — an "after" row exactly at
        // scheduledEnd with nothing following would be zero-length. Carries
        // the same greenhouse_row_id and carrier_id forward — the employee
        // never actually moved or changed carriers, this is only an
        // automatic break carve-out, so the "after" segment must stay
        // attached to the same row/carrier the "before" segment was (which
        // itself keeps its originals for free, since only ended_at is
        // updated on it above).
        if (!workEnd || workEnd.getTime() > scheduledEnd.getTime()) {
          // Carries the same density_type/density_count_per_row snapshot
          // forward from the row being split — it's the same row/activity,
          // just interrupted by the break, so the "after" segment must
          // report the identical resolved density, never re-resolved (see
          // openEntry() in mobileTime.ts for where it was originally
          // resolved).
          await client.query(
            `insert into time_entries
               (employee_id, device_id, entry_type, activity_id, started_at, ended_at, idempotency_key,
                greenhouse_row_id, carrier_id, density_type, density_count_per_row)
             values ($1, $2, 'work', $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              employeeId,
              w.device_id,
              w.activity_id,
              scheduledEnd,
              workEnd,
              randomUUID(),
              w.greenhouse_row_id,
              w.carrier_id,
              w.density_type,
              w.density_count_per_row,
            ]
          );
        }

        await client.query(`release savepoint ${savepoint}`);
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505") {
          // Lost a race against a concurrent reconciliation pass for the
          // same employee/item/date — it already exists now, move on.
          await client.query(`rollback to savepoint ${savepoint}`);
          continue;
        }
        throw err;
      }
    }

    await client.query("commit");
    console.log(`[timing] reconcileEmployeeBreaks total (${itemsRes.rows.length} auto-add items): ${Date.now() - __t0}ms`);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
