// Bin picking cycles (migration 074). Every harvest weighing belongs to at
// most one picking cycle; a cycle is closed by at most one weighing.
//
// The rule, per bin, in event time (phone occurred_at / station weighed_at):
// * A phone bin choice (accepted work_start / activity_switch answering a
//   carrier question, phone clock not flagged) made after cycle tracking
//   started opens a cycle if none is open, or joins the open one.
// * A choice by a second employee makes the open cycle needs_review: the
//   first employee is never silently replaced.
// * The bin's next weighing (not a five-minute duplicate) closes the open
//   cycle. One employee in it: the weighing is credited to them. More than
//   one: the weighing is needs_review, nobody is credited.
// * A weighing with no open cycle (weighed again, nobody scanned it since)
//   is linked to no cycle and is never credited, unless a phone scan dated
//   before it, and after the previous weighing, reaches LabourLink within
//   the existing 24-hour recovery window.
// * An administrator may close an open cycle without weighing (bin emptied
//   or abandoned); its scans are never credited.
//
// Late and out-of-order events are placed by their own timestamps: a scan
// belongs to the interval ending at the bin's first boundary (weighing or
// administrator closure) at or after it. Closed cycles are final. A late scan
// that falls inside one is recorded with it but never changes its outcome
// (another employee's is flagged late_conflict, as before). Only the open
// cycle (and scans not yet placed) are re-placed, so a weighing uploaded late
// after a network outage still closes the cycle that was open at its time.
//
// While no bin_cycle_tracking row exists the existing rule
// (scaleMatchingRule.ts) applies unchanged. Weighings before started_at keep
// that rule; phone scans before it never open a cycle.
import { PoolClient } from "pg";
import { pool } from "../db";
import { PENDING_RECOVERY_MS } from "./scaleMatchingRule";

export const OPEN_STATUSES = ["filling", "awaiting_weighing", "needs_review"] as const;
export type CycleStatus = (typeof OPEN_STATUSES)[number] | "closed" | "closed_unweighed";

export const NO_CYCLE_REASON = "No picking cycle: nobody has chosen this bin on a phone since it was last weighed. Not credited.";
const CREDITED_REASON = "One employee chose this bin on their phone during this picking cycle";
const REVIEW_REASON = "More than one employee chose this bin during this picking cycle";
const TOO_LATE_REASON = "The bin was weighed before these phone scans reached LabourLink in time. Not credited.";
const HELD_REASON = "The weighing that closed this cycle is held for review, so nobody was credited.";

// ---------------------------------------------------------------------------
// Pure placement (unit-tested in binCycles.rule.test.ts)
// ---------------------------------------------------------------------------
export interface PlaceScan {
  id: string;
  employeeId: string;
  occurredAt: number;
}
export interface Boundary {
  key: string; // weighing id, or "u:" + cycle id for an administrator closure
  at: number;
}
// Groups scans by the first boundary at or after them (a scan at the same
// instant as a weighing belongs to it). Scans after every boundary go to
// "open". Boundaries must be sorted by time.
export function placeScans(scans: PlaceScan[], boundaries: Boundary[]): Map<string, PlaceScan[]> {
  const out = new Map<string, PlaceScan[]>();
  const sorted = [...scans].sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  for (const s of sorted) {
    const b = boundaries.find((x) => x.at >= s.occurredAt);
    const key = b ? b.key : "open";
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(s);
  }
  return out;
}
export function distinctEmployees(scans: PlaceScan[]): string[] {
  return [...new Set(scans.map((s) => s.employeeId))];
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
export async function trackingStart(db: PoolClient | typeof pool): Promise<Date | null> {
  const { rows } = await db.query(`select started_at from bin_cycle_tracking where id`);
  return rows[0] ? new Date(rows[0].started_at) : null;
}

async function cycleEvent(
  client: PoolClient,
  e: {
    cycleId: string;
    kind: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    employeeId?: string | null;
    actorEmployeeId?: string | null;
    weighingId?: string | null;
    mobileTimeEventId?: string | null;
    reason?: string | null;
    detail?: unknown;
  }
) {
  await client.query(
    `insert into bin_cycle_events (cycle_id, kind, from_status, to_status, employee_id, actor_employee_id, weighing_id, mobile_time_event_id, reason, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.cycleId,
      e.kind,
      e.fromStatus ?? null,
      e.toStatus ?? null,
      e.employeeId ?? null,
      e.actorEmployeeId ?? null,
      e.weighingId ?? null,
      e.mobileTimeEventId ?? null,
      e.reason ?? null,
      e.detail === undefined ? null : JSON.stringify(e.detail),
    ]
  );
}

async function weighingEvent(client: PoolClient, weighingId: string, kind: string, from: string | null, to: string | null, employeeId: string | null, reason: string | null, detail?: unknown) {
  await client.query(
    `insert into scale_weighing_events (weighing_id, kind, from_status, to_status, employee_id, reason, detail) values ($1, $2, $3, $4, $5, $6, $7)`,
    [weighingId, kind, from, to, employeeId, reason, detail === undefined ? null : JSON.stringify(detail)]
  );
}

// Records accepted phone bin choices (since tracking started) in bin_scans.
// Idempotent: a re-uploaded event is the same row. Returns the carriers.
export async function recordBinScans(client: PoolClient | typeof pool, where: { deviceId: string; clientEventIds: string[] } | { receivedSince: Date }): Promise<string[]> {
  const t0 = await trackingStart(client);
  if (!t0) return [];
  const filter =
    "deviceId" in where ? `m.device_id = $2 and m.client_event_id = any($3::uuid[])` : `m.received_at >= $2`;
  const params: unknown[] = "deviceId" in where ? [t0, where.deviceId, where.clientEventIds] : [t0, where.receivedSince];
  const { rows } = await client.query(
    `insert into bin_scans (mobile_time_event_id, carrier_id, employee_id, occurred_at, received_at, clock_trusted)
     select m.id, c.id, m.employee_id, m.occurred_at_utc, m.received_at,
            not coalesce(m.conflict_detail ? 'forwardSkewMs' or m.conflict_detail ? 'regressionMs', false)
     from mobile_time_events m
     cross join lateral (
       select a->>'carrierId' as carrier_id from jsonb_path_query(m.payload, '$.answers.*') a
         where jsonb_typeof(a) = 'object' and a ? 'carrierId'
       union
       select a->>'carrierId' from jsonb_path_query(m.payload, '$.answers[*]') a
         where jsonb_typeof(a) = 'object' and a ? 'carrierId'
     ) chosen
     join carriers c on c.id::text = chosen.carrier_id
     where ${filter}
       and m.processing_status = 'accepted'
       and m.event_type in ('work_start', 'activity_switch')
       and m.employee_id is not null
       and m.occurred_at_utc > $1
     on conflict (mobile_time_event_id) do nothing
     returning carrier_id`,
    params
  );
  return [...new Set(rows.map((r) => r.carrier_id as string))];
}

interface ScanRow extends PlaceScan {
  receivedAt: number;
  cycleId: string | null;
}

// Whether the cycle's employee is still on the bin: their open work entry is
// on it, or they are on a break taken from it. Otherwise it awaits weighing
// (switched bin or activity, finished work, midnight cutoff, admin end).
async function fillingState(client: PoolClient, carrierId: string, employeeId: string, openedAt: Date): Promise<{ filling: boolean; awaitingSince: Date | null }> {
  const { rows: open } = await client.query(
    `select entry_type, carrier_id, started_at from time_entries
     where employee_id = $1 and ended_at is null and deleted_at is null order by started_at desc limit 1`,
    [employeeId]
  );
  let filling = false;
  if (open[0]?.entry_type === "work") filling = open[0].carrier_id === carrierId;
  else if (open[0]?.entry_type === "break") {
    const { rows: before } = await client.query(
      `select carrier_id from time_entries where employee_id = $1 and entry_type = 'work' and deleted_at is null and started_at <= $2
       order by started_at desc limit 1`,
      [employeeId, open[0].started_at]
    );
    filling = before[0]?.carrier_id === carrierId;
  }
  if (filling) return { filling: true, awaitingSince: null };
  const { rows: last } = await client.query(
    `select max(ended_at) as ended_at from time_entries
     where employee_id = $1 and carrier_id = $2 and entry_type = 'work' and deleted_at is null and ended_at >= $3`,
    [employeeId, carrierId, openedAt]
  );
  return { filling: false, awaitingSince: last[0]?.ended_at ? new Date(last[0].ended_at) : null };
}

async function employeeNames(client: PoolClient, ids: string[]): Promise<string> {
  const { rows } = await client.query(
    `select trim(first_name || ' ' || coalesce(last_name, '')) as n from employees where id = any($1::uuid[]) order by 1`,
    [ids]
  );
  return rows.map((r) => r.n).join(", ");
}

// Re-places a bin's open and unplaced scans and links its unlinked weighings.
// Caller holds lockCarrier() inside an open transaction. Idempotent.
export async function reconcileBinCyclesLocked(client: PoolClient, carrierId: string, now: Date = new Date()): Promise<void> {
  const t0 = await trackingStart(client);
  if (!t0) return;

  const { rows: openRows } = await client.query(
    `select * from bin_cycles where carrier_id = $1 and status = any($2::text[]) for update`,
    [carrierId, OPEN_STATUSES]
  );
  const open = openRows[0] ?? null;
  const { rows: scanRows } = await client.query(
    `select s.mobile_time_event_id, s.employee_id, s.occurred_at, s.received_at, s.cycle_id
     from bin_scans s
     where s.carrier_id = $1 and s.clock_trusted and (s.cycle_id is null or s.cycle_id = $2)
     order by s.occurred_at, s.mobile_time_event_id`,
    [carrierId, open?.id ?? null]
  );
  const scans: ScanRow[] = scanRows.map((r) => ({
    id: r.mobile_time_event_id,
    employeeId: r.employee_id,
    occurredAt: new Date(r.occurred_at).getTime(),
    receivedAt: new Date(r.received_at).getTime(),
    cycleId: r.cycle_id,
  }));

  // Boundaries from the earliest scan to place, plus every unlinked pending
  // weighing (it still needs its reason and, after 24 h, expiry).
  const from = scans.length ? new Date(scans[0].occurredAt) : null; // null: no scan to place

  const { rows: bRows } = await client.query(
    `select 'w' as kind, w.id, w.weighed_at as at, w.status, w.pending_until, w.match_reason, c.id as cycle_id
       from scale_weighings w left join bin_cycles c on c.weighing_id = w.id
       where w.carrier_id = $1 and w.weighed_at > $2 and not w.is_duplicate
         and (w.weighed_at >= $3::timestamptz or (w.status = 'pending' and c.id is null))
     union all
     select 'u', null, c.closed_at, c.status, null, null, c.id
       from bin_cycles c
       where c.carrier_id = $1 and c.status = 'closed_unweighed' and c.closed_at >= $3::timestamptz
     order by at`,
    [carrierId, t0, from]
  );
  const boundaries = bRows.map((r) => ({ ...r, key: r.kind === "w" ? r.id : `u:${r.cycle_id}`, at: new Date(r.at).getTime() }));
  const groups = placeScans(scans, boundaries);
  const byId = new Map(scans.map((s) => [s.id, s]));
  let openReused = false;

  const moveScans = async (cycleId: string, group: PlaceScan[], late: boolean) => {
    for (const s of group) {
      const prev = byId.get(s.id)!.cycleId;
      if (prev === cycleId) continue;
      await client.query(`update bin_scans set cycle_id = $2 where mobile_time_event_id = $1`, [s.id, cycleId]);
      await cycleEvent(client, {
        cycleId,
        kind: late ? "late_scan" : prev ? "scan_moved" : "scan",
        employeeId: s.employeeId,
        mobileTimeEventId: s.id,
        detail: prev ? { fromCycleId: prev } : undefined,
      });
    }
  };

  for (const b of boundaries) {
    const group = groups.get(b.key) ?? [];
    if (b.kind === "u" || b.cycle_id) {
      // A final cycle: late scans join it and never change its outcome.
      if (group.length === 0) continue;
      await moveScans(b.cycle_id, group, true);
      if (b.kind === "w") {
        const { rows: wr } = await client.query(`select status, employee_id from scale_weighings where id = $1`, [b.id]);
        for (const s of group) {
          if (wr[0].status === "credited" && s.employeeId === wr[0].employee_id) {
            await client.query(
              `insert into scale_weighing_claims (mobile_time_event_id, weighing_id, employee_id) values ($1, $2, $3) on conflict do nothing`,
              [s.id, b.id, s.employeeId]
            );
          } else if (wr[0].status === "credited" || wr[0].status === "needs_review") {
            const kind = wr[0].status === "credited" ? "late_conflict" : "competing";
            const ins = await client.query(
              `insert into scale_weighing_flags (weighing_id, mobile_time_event_id, employee_id, kind) values ($1, $2, $3, $4)
               on conflict (weighing_id, mobile_time_event_id) do nothing`,
              [b.id, s.id, s.employeeId, kind]
            );
            if (kind === "late_conflict" && ins.rowCount === 1) {
              await weighingEvent(client, b.id, "late_conflict", null, null, s.employeeId,
                "Another employee chose this bin during a picking cycle that was already credited. The credit is unchanged.", { mobileTimeEventId: s.id });
            }
          }
        }
      }
      continue;
    }

    // An unlinked weighing.
    if (group.length === 0) {
      if (b.status === "pending") {
        if (now.getTime() >= new Date(b.pending_until).getTime()) {
          await client.query(`update scale_weighings set status = 'expired', match_reason = $2, resolved_at = now() where id = $1`, [b.id, NO_CYCLE_REASON]);
          await weighingEvent(client, b.id, "status", "pending", "expired", null, NO_CYCLE_REASON);
        } else if (b.match_reason !== NO_CYCLE_REASON) {
          await client.query(`update scale_weighings set match_reason = $2 where id = $1`, [b.id, NO_CYCLE_REASON]);
        }
      }
      continue;
    }

    // The scans before this weighing form the cycle it closes. The open
    // cycle's row keeps its identity if its scans are here.
    const employees = distinctEmployees(group);
    const reuse = !openReused && open && group.some((s) => byId.get(s.id)!.cycleId === open.id) ? open : null;
    const opened = new Date(group[0].occurredAt);
    const last = new Date(group[group.length - 1].occurredAt);
    const reviewReason = employees.length > 1 ? `Chosen by more than one employee: ${await employeeNames(client, employees)}` : null;
    const closeReason = b.status === "pending" ? null : b.status === "expired" ? TOO_LATE_REASON : HELD_REASON;
    let cycleId: string;
    if (reuse) {
      openReused = true;
      cycleId = reuse.id;
      await client.query(
        `update bin_cycles set status = 'closed', employee_id = $2, opened_at = $3, last_scan_at = $4, awaiting_since = coalesce(awaiting_since, $5),
           review_reason = $6, weighing_id = $7, closed_at = $5, close_reason = $8, updated_at = now() where id = $1`,
        [cycleId, group[0].employeeId, opened, last, new Date(b.at), reviewReason, b.id, closeReason]
      );
      await moveScans(cycleId, group, false);
      await cycleEvent(client, { cycleId, kind: "weighed", fromStatus: reuse.status, toStatus: "closed", weighingId: b.id, reason: closeReason ?? reviewReason });
    } else {
      const { rows: ins } = await client.query(
        `insert into bin_cycles (carrier_id, status, employee_id, opened_at, last_scan_at, review_reason, weighing_id, closed_at, close_reason)
         values ($1, 'closed', $2, $3, $4, $5, $6, $7, $8) returning id`,
        [carrierId, group[0].employeeId, opened, last, reviewReason, b.id, new Date(b.at), closeReason]
      );
      cycleId = ins[0].id;
      await cycleEvent(client, { cycleId, kind: "opened", toStatus: "closed", employeeId: group[0].employeeId, mobileTimeEventId: group[0].id, detail: { lateScans: true } });
      await moveScans(cycleId, group, false);
      await cycleEvent(client, { cycleId, kind: "weighed", toStatus: "closed", weighingId: b.id, reason: closeReason ?? reviewReason });
    }

    if (b.status !== "pending") continue; // already final: never credited now
    const scanIds = group.map((s) => s.id);
    if (employees.length === 1) {
      for (const s of group) {
        await client.query(
          `insert into scale_weighing_claims (mobile_time_event_id, weighing_id, employee_id) values ($1, $2, $3) on conflict do nothing`,
          [s.id, b.id, s.employeeId]
        );
      }
      await client.query(`update scale_weighings set status = 'credited', employee_id = $2, match_reason = $3, resolved_at = now() where id = $1`, [b.id, employees[0], CREDITED_REASON]);
      await weighingEvent(client, b.id, "status", "pending", "credited", employees[0], CREDITED_REASON, { binCycleId: cycleId, mobileTimeEventIds: scanIds });
    } else {
      for (const s of group) {
        await client.query(
          `insert into scale_weighing_flags (weighing_id, mobile_time_event_id, employee_id, kind) values ($1, $2, $3, 'competing') on conflict do nothing`,
          [b.id, s.id, s.employeeId]
        );
      }
      await client.query(`update scale_weighings set status = 'needs_review', match_reason = $2, resolved_at = now() where id = $1`, [b.id, REVIEW_REASON]);
      await weighingEvent(client, b.id, "status", "pending", "needs_review", null, REVIEW_REASON, { binCycleId: cycleId, mobileTimeEventIds: scanIds });
    }
  }

  // Scans after the last boundary: the bin's open cycle.
  const openGroup = groups.get("open") ?? [];
  if (openGroup.length === 0) return;
  const employees = distinctEmployees(openGroup);
  const opened = new Date(openGroup[0].occurredAt);
  const last = new Date(openGroup[openGroup.length - 1].occurredAt);
  let status: CycleStatus;
  let awaitingSince: Date | null = null;
  let reviewReason: string | null = null;
  if (employees.length > 1) {
    status = "needs_review";
    reviewReason = `Chosen by more than one employee: ${await employeeNames(client, employees)}`;
  } else {
    const f = await fillingState(client, carrierId, employees[0], opened);
    status = f.filling ? "filling" : "awaiting_weighing";
    awaitingSince = f.filling ? null : f.awaitingSince ?? last;
  }
  if (open && !openReused) {
    const awaitingChanged = (open.awaiting_since ? +new Date(open.awaiting_since) : null) !== (awaitingSince ? +awaitingSince : null);
    if (awaitingChanged || open.status !== status || open.review_reason !== reviewReason || +new Date(open.opened_at) !== +opened || +new Date(open.last_scan_at) !== +last || open.employee_id !== openGroup[0].employeeId) {
      await client.query(
        `update bin_cycles set status = $2, employee_id = $3, opened_at = $4, last_scan_at = $5, awaiting_since = $6, review_reason = $7, updated_at = now() where id = $1`,
        [open.id, status, openGroup[0].employeeId, opened, last, awaitingSince, reviewReason]
      );
      if (open.status !== status) await cycleEvent(client, { cycleId: open.id, kind: "status", fromStatus: open.status, toStatus: status, reason: reviewReason });
    }
    await moveScans(open.id, openGroup, false);
  } else {
    const { rows: ins } = await client.query(
      `insert into bin_cycles (carrier_id, status, employee_id, opened_at, last_scan_at, awaiting_since, review_reason)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [carrierId, status, openGroup[0].employeeId, opened, last, awaitingSince, reviewReason]
    );
    const cycleId = ins[0].id as string;
    await cycleEvent(client, { cycleId, kind: "opened", toStatus: status, employeeId: openGroup[0].employeeId, mobileTimeEventId: openGroup[0].id, reason: reviewReason });
    await moveScans(cycleId, openGroup.slice(0), false);
  }
}

async function inCarrierTransaction(carrierId: string, fn: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext('scale-carrier:' || $1::text))`, [carrierId]);
    await fn(client);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function reconcileBins(carrierIds: string[]): Promise<void> {
  for (const id of [...new Set(carrierIds)]) await inCarrierTransaction(id, (c) => reconcileBinCyclesLocked(c, id));
}

// After a phone sync: record the device's new bin choices, then re-place
// those bins and refresh the employee's open cycles (a switch to another bin
// or activity, or Finish Work, moves their bin to awaiting weighing).
// Never throws, so it can't affect phone sync.
export async function reconcileCyclesAfterPhoneSync(deviceId: string, clientEventIds: string[], employeeId: string | null): Promise<void> {
  if (process.env.SCALE_MATCHING_ENABLED === "false") return; // same switch as scale matching
  try {
    if (!(await trackingStart(pool))) return;
    const bins = await recordBinScans(pool, { deviceId, clientEventIds });
    if (employeeId) {
      const { rows } = await pool.query(
        `select distinct c.carrier_id from bin_cycles c join bin_scans s on s.cycle_id = c.id
         where c.status = any($1::text[]) and s.employee_id = $2`,
        [OPEN_STATUSES, employeeId]
      );
      bins.push(...rows.map((r) => r.carrier_id));
    }
    await reconcileBins(bins);
  } catch (err) {
    console.error("[bin-cycles] reconcile after phone sync failed:", err instanceof Error ? err.message : err);
  }
}

// Safety net (runs with the scale-matching sweep): picks up bin choices a
// missed post-sync run left out, expires unlinked weighings and refreshes
// every open cycle's filling / awaiting state (midnight cutoff, admin end).
export async function sweepBinCycles(now: Date = new Date()): Promise<void> {
  try {
    if (!(await trackingStart(pool))) return;
    const bins = await recordBinScans(pool, { receivedSince: new Date(now.getTime() - 2 * PENDING_RECOVERY_MS) });
    const { rows } = await pool.query(
      `select carrier_id from bin_cycles where status = any($1::text[])
       union select carrier_id from bin_scans where cycle_id is null and clock_trusted
       union select w.carrier_id from scale_weighings w, bin_cycle_tracking t
         where w.status = 'pending' and w.weighed_at > t.started_at`,
      [OPEN_STATUSES]
    );
    await reconcileBins([...bins, ...rows.map((r) => r.carrier_id)]);
  } catch (err) {
    console.error("[bin-cycles] sweep failed:", err instanceof Error ? err.message : err);
  }
}

// Administrator: close an open cycle without a weighing (bin emptied or
// abandoned). Nobody is credited for it; the bin's next scan starts a new
// cycle. Idempotent on requestId.
export async function closeCycleWithoutWeighing(
  cycleId: string,
  requestId: string,
  reason: string,
  actorEmployeeId: string
): Promise<{ ok: true; replay: boolean } | { ok: false; status: number; error: string; code: string }> {
  const { rows: c0 } = await pool.query(`select carrier_id from bin_cycles where id = $1`, [cycleId]);
  if (!c0[0]) return { ok: false, status: 404, error: "Picking cycle not found", code: "notFound" };
  let result: { ok: true; replay: boolean } | { ok: false; status: number; error: string; code: string } = { ok: true, replay: false };
  await inCarrierTransaction(c0[0].carrier_id, async (client) => {
    const { rows: done } = await client.query(`select id from bin_cycles where close_request_id = $1`, [requestId]);
    if (done[0]) {
      result = done[0].id === cycleId ? { ok: true, replay: true } : { ok: false, status: 409, error: "This request was already used for another cycle", code: "requestReused" };
      return;
    }
    // Place anything that arrived first, so the closure covers the cycle as it is now.
    await reconcileBinCyclesLocked(client, c0[0].carrier_id);
    const { rows } = await client.query(`select status from bin_cycles where id = $1 for update`, [cycleId]);
    if (!OPEN_STATUSES.includes(rows[0].status)) {
      result = { ok: false, status: 409, error: "Only an open picking cycle can be closed", code: "notOpen" };
      return;
    }
    await client.query(
      `update bin_cycles set status = 'closed_unweighed', closed_at = now(), close_reason = $2, closed_by_employee_id = $3, close_request_id = $4, updated_at = now() where id = $1`,
      [cycleId, reason, actorEmployeeId, requestId]
    );
    await cycleEvent(client, { cycleId, kind: "closed_unweighed", fromStatus: rows[0].status, toStatus: "closed_unweighed", actorEmployeeId, reason });
  });
  return result;
}
