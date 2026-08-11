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

// The two employee columns every caller needs before deciding whether
// there's anything to reconcile at all — is_active and break_profile_id.
// Callers that already fetched the employee row this same request (GET
// /api/inputs/daily fetches id/first_name/last_name/profile_photo_path for
// its own response and can select these two alongside them for free) should
// pass it in directly rather than have this function ask again a few
// milliseconds later; a caller with no such row on hand (mobileTime.ts's
// serializeStatus, which only has requireDevice's employeeId/name/language)
// omits it and this function fetches it itself, exactly as it always did.
export interface KnownEmployeeBreakInfo {
  isActive: boolean;
  breakProfileId: string | null;
}

async function fetchEmployeeBreakInfo(employeeId: string): Promise<KnownEmployeeBreakInfo> {
  const { rows } = await pool.query(`select is_active, break_profile_id from employees where id = $1`, [employeeId]);
  const row = rows[0];
  return { isActive: row?.is_active ?? false, breakProfileId: row?.break_profile_id ?? null };
}

export async function reconcileEmployeeBreaks(
  employeeId: string,
  dateStr: string,
  knownEmployee?: KnownEmployeeBreakInfo
): Promise<void> {
  const emp = knownEmployee ?? (await fetchEmployeeBreakInfo(employeeId));
  // No transaction, no connection ever opened for the (common) case where
  // there's nothing this employee could have — an inactive employee or one
  // with no assigned break profile can never have an auto-add item to
  // reconcile, so there's nothing worth a round trip to confirm further.
  if (!emp.isActive || !emp.breakProfileId) return;

  // Combines the old two separate round trips ("is this break profile
  // still active" then "which of its items are auto-add") into one — a
  // profile that's since been deactivated simply joins to zero items,
  // which is exactly the same "nothing to reconcile" outcome the old
  // separate profileRes check produced, just without a second query to
  // learn it.
  const itemsRes = await pool.query<AutoAddItem>(
    `select bpi.id, bpi.start_time, bpi.end_time, bpi.is_paid
     from break_profiles bp
     join break_profile_items bpi on bpi.break_profile_id = bp.id
     where bp.id = $1 and bp.is_active = true and bpi.auto_add = true and bpi.is_active = true
     order by bpi.start_time asc`,
    [emp.breakProfileId]
  );
  // Nothing to reconcile — same early exit as before, just reached without
  // ever opening a transaction (there was never anything for one to
  // protect in this case; the old code opened begin/commit around zero
  // writes here too, which offered no atomicity benefit).
  if (itemsRes.rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("begin");

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
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
