// Bin picking cycles (migration 074). Every harvest weighing belongs to at
// most one picking cycle; a cycle is closed by at most one weighing.
//
// The rule, per bin, in event time (phone occurred_at / station weighed_at):
// * A phone bin choice made during a tracking period opens a cycle if none is
//   open, or joins the open one. A bin choice is an accepted work_start /
//   activity_switch answering a carrier question, or a bin_rescan (the
//   employee scanned the bin they are already using again), with the phone
//   clock not flagged.
// * Consecutive choices by the same employee (row changes, repeat scans)
//   stay one cycle; resuming after a break is not a choice at all.
// * A choice by a different employee means the bin was emptied and reused
//   (075): the earlier cycle is SUPERSEDED (no weighing, no credit, kept with
//   its scans and flagged for administrator review) and a new cycle opens.
// * The bin's next weighing (not a five-minute duplicate) closes the latest
//   cycle and credits its employee. An administrator can credit a
//   superseded cycle instead (reviewSupersededCycle); a needs-review cycle
//   from before 075 is still resolved with resolveCycle.
// * A weighing with no open cycle (weighed again, nobody scanned it since)
//   is linked to no cycle and is never credited, unless a phone scan dated
//   before it, and after the previous weighing, reaches LabourLink within
//   the existing 24-hour recovery window.
// * An administrator may close an open cycle without weighing (bin emptied
//   or abandoned). Stopping cycle tracking closes every open cycle the same
//   way. Neither credits anyone.
//
// Late and out-of-order events are placed by their own timestamps: a scan
// belongs to the interval ending at the bin's first boundary (weighing,
// closure, or the end of its tracking period) at or after it. Closed cycles
// are final: a late scan inside one is recorded with it but never changes its
// outcome (another employee's is flagged late_conflict). Only the open cycle
// and scans not yet placed are re-placed, so a weighing uploaded late after a
// network outage still closes the cycle that was open at its time.
//
// Tracking periods (bin_cycle_tracking): weighings and scans inside a period
// follow these rules. Outside any period the existing rule
// (scaleMatchingRule.ts) applies, except that after a stop it never uses a
// scan from before the stop (scaleMatching.ts), so stopping can't let stale
// scans credit anything.
import { randomUUID } from "crypto";
import { PoolClient } from "pg";
import { pool } from "../db";
import { PENDING_RECOVERY_MS } from "./scaleMatchingRule";

export const OPEN_STATUSES = ["filling", "awaiting_weighing", "needs_review"] as const;
export type CycleStatus = (typeof OPEN_STATUSES)[number] | "closed" | "closed_unweighed" | "superseded";

export const NO_CYCLE_REASON = "No picking cycle: nobody has chosen this bin on a phone since it was last weighed. Not credited.";
const CREDITED_REASON = "One employee chose this bin on their phone during this picking cycle";
const CREDITED_LATEST_REASON = "Credited to the latest picking cycle before the weighing; earlier cycles by other employees were superseded";
const REVIEW_REASON = "More than one employee chose this bin during this picking cycle";
const TOO_LATE_REASON = "The bin was weighed before these phone scans reached LabourLink in time. Not credited.";
const HELD_REASON = "The weighing that closed this cycle is held for review, so nobody was credited.";
export const STOPPED_REASON = "Picking-cycle tracking was stopped while this cycle was open. Not credited.";

// SQL: is a timestamp inside a tracking period?
const IN_PERIOD = (col: string) =>
  `exists (select 1 from bin_cycle_tracking p where ${col} > p.started_at and (p.stopped_at is null or ${col} <= p.stopped_at))`;

// ---------------------------------------------------------------------------
// Pure placement (tested in routes/binCycles.test.ts)
// ---------------------------------------------------------------------------
export interface PlaceScan {
  id: string;
  employeeId: string;
  occurredAt: number;
}
export interface Boundary {
  key: string;
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
type Db = PoolClient | typeof pool;

// Whether any tracking period was ever started (otherwise nothing here runs).
export async function trackingEverStarted(db: Db): Promise<boolean> {
  return (await db.query(`select 1 from bin_cycle_tracking limit 1`)).rows.length > 0;
}
// Whether a tracking period is running now (phones send bin_rescan only then).
export async function trackingRunning(db: Db): Promise<boolean> {
  return (await db.query(`select 1 from bin_cycle_tracking where stopped_at is null and started_at <= now() limit 1`)).rows.length > 0;
}
export async function isTracked(db: Db, at: Date): Promise<boolean> {
  return (await db.query(`select ${IN_PERIOD("$1::timestamptz")} as t`, [at])).rows[0].t === true;
}
// The latest stop at or before `at` (the existing rule never uses a scan from
// before it).
export async function lastStopBefore(db: Db, at: Date): Promise<Date | null> {
  const { rows } = await db.query(`select max(stopped_at) as s from bin_cycle_tracking where stopped_at <= $1`, [at]);
  return rows[0].s ? new Date(rows[0].s) : null;
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

async function weighingEvent(
  client: PoolClient,
  weighingId: string,
  kind: string,
  from: string | null,
  to: string | null,
  employeeId: string | null,
  reason: string | null,
  detail?: unknown,
  actorEmployeeId: string | null = null
) {
  await client.query(
    `insert into scale_weighing_events (weighing_id, kind, from_status, to_status, employee_id, actor_employee_id, reason, detail) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [weighingId, kind, from, to, employeeId, actorEmployeeId, reason, detail === undefined ? null : JSON.stringify(detail)]
  );
}

// Records accepted phone bin choices made during a tracking period in
// bin_scans. Idempotent: a re-uploaded event is the same row. Returns the
// carriers touched.
export async function recordBinScans(db: Db, where: { deviceId: string; clientEventIds: string[] } | { receivedSince: Date }): Promise<string[]> {
  const filter = "deviceId" in where ? `m.device_id = $1 and m.client_event_id = any($2::uuid[])` : `m.received_at >= $1`;
  const params: unknown[] = "deviceId" in where ? [where.deviceId, where.clientEventIds] : [where.receivedSince];
  const { rows } = await db.query(
    `insert into bin_scans (mobile_time_event_id, carrier_id, employee_id, occurred_at, received_at, clock_trusted)
     select distinct on (m.id) m.id, c.id, m.employee_id, m.occurred_at_utc, m.received_at,
            not coalesce(m.conflict_detail ? 'forwardSkewMs' or m.conflict_detail ? 'regressionMs', false)
     from mobile_time_events m
     cross join lateral (
       select a->>'carrierId' as carrier_id from jsonb_path_query(m.payload, '$.answers.*') a
         where jsonb_typeof(a) = 'object' and a ? 'carrierId'
       union
       select a->>'carrierId' from jsonb_path_query(m.payload, '$.answers[*]') a
         where jsonb_typeof(a) = 'object' and a ? 'carrierId'
       union
       select m.payload->>'carrierId' where m.event_type = 'bin_rescan'
     ) chosen
     join carriers c on c.id::text = chosen.carrier_id
     where ${filter}
       and m.processing_status = 'accepted'
       and m.event_type in ('work_start', 'activity_switch', 'bin_rescan')
       and m.employee_id is not null
       and ${IN_PERIOD("m.occurred_at_utc")}
     order by m.id
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

async function addClaim(client: PoolClient, scanId: string, weighingId: string, employeeId: string) {
  await client.query(
    `insert into scale_weighing_claims (mobile_time_event_id, weighing_id, employee_id) values ($1, $2, $3) on conflict do nothing`,
    [scanId, weighingId, employeeId]
  );
}

// One cycle per run of consecutive scans by the same employee (row changes,
// repeat scans and break resumes stay in one cycle). A different employee's
// scan starts a new cycle and supersedes the one before it: the bin was
// emptied and reused. The latest run before a weighing gets the credit.
export function splitRuns<T extends PlaceScan>(group: T[]): T[][] {
  const runs: T[][] = [];
  for (const s of group) {
    const last = runs[runs.length - 1];
    if (last && last[0].employeeId === s.employeeId) last.push(s);
    else runs.push([s]);
  }
  return runs;
}

const SUPERSEDED_REASON = "Another employee started using this bin before it was weighed. This cycle gets no weighing or credit.";
export const LATE_SUPERSEDED_REASON =
  "This scan reached LabourLink after the bin's weighing was already credited to another employee. Not credited; flagged for review.";

// Re-places a bin's open, superseded-but-unsettled and unplaced scans and
// links its unlinked weighings. Caller holds lockCarrier() inside an open
// transaction. Idempotent.
export async function reconcileBinCyclesLocked(client: PoolClient, carrierId: string, now: Date = new Date()): Promise<void> {
  if (!(await trackingEverStarted(client))) return;

  // An open cycle from a period that has since been stopped is closed (by
  // the system, at the stop) before anything else: it can never be credited
  // (except by a weighing made before the stop, see softRows). Superseded
  // cycles of that period are settled.
  const { rows: stale } = await client.query(
    `select c.id, c.status, p.stopped_at from bin_cycles c
     join bin_cycle_tracking p on c.opened_at > p.started_at and p.stopped_at is not null and c.opened_at <= p.stopped_at
     where c.carrier_id = $1 and c.status = any($2::text[]) for update of c`,
    [carrierId, OPEN_STATUSES]
  );
  for (const s of stale) {
    await client.query(
      `update bin_cycles set status = 'closed_unweighed', closed_at = $2, close_reason = $3, updated_at = now() where id = $1`,
      [s.id, s.stopped_at, STOPPED_REASON]
    );
    await cycleEvent(client, { cycleId: s.id, kind: "closed_unweighed", fromStatus: s.status, toStatus: "closed_unweighed", reason: STOPPED_REASON });
  }
  await client.query(
    `update bin_cycles c set finalized_at = p.stopped_at, updated_at = now() from bin_cycle_tracking p
     where c.carrier_id = $1 and c.status = 'superseded' and c.finalized_at is null
       and p.stopped_at is not null and c.opened_at > p.started_at and c.closed_at <= p.stopped_at`,
    [carrierId]
  );

  const { rows: openRows } = await client.query(
    `select * from bin_cycles where carrier_id = $1 and status = any($2::text[]) for update`,
    [carrierId, OPEN_STATUSES]
  );
  const open = openRows[0] ?? null;
  // A cycle closed by stopping tracking (not by an administrator) stays
  // available to a weighing made before the stop that only reached
  // LabourLink afterwards (the station was offline): that weighing closes
  // the cycle that was open at its time and is credited as usual.
  const { rows: softRows } = await client.query(
    `select c.* from bin_cycles c
     where c.carrier_id = $1 and c.status = 'closed_unweighed' and c.closed_by_employee_id is null and c.close_request_id is null
       and exists (select 1 from scale_weighings w left join bin_cycles l on l.weighing_id = w.id
                   where w.carrier_id = c.carrier_id and l.id is null and w.status = 'pending' and not w.is_duplicate
                     and w.weighed_at >= c.opened_at and w.weighed_at <= c.closed_at)
     order by c.opened_at for update`,
    [carrierId]
  );
  // Superseded cycles whose bin hasn't been weighed or closed yet: delayed
  // events can still re-place them.
  // Also, like a stop-closed cycle, a superseded cycle of a stopped period
  // while a weighing made in that period (station offline) is still unlinked.
  const { rows: unsettled } = await client.query(
    `select c.* from bin_cycles c
     where c.carrier_id = $1 and c.status = 'superseded'
       and (c.finalized_at is null
            or exists (select 1 from bin_cycle_tracking p
                       join scale_weighings w on w.carrier_id = c.carrier_id and w.status = 'pending' and not w.is_duplicate
                         and w.weighed_at >= c.opened_at and w.weighed_at > p.started_at and w.weighed_at <= p.stopped_at
                       left join bin_cycles l on l.weighing_id = w.id
                       where p.stopped_at is not null and c.opened_at > p.started_at and c.opened_at <= p.stopped_at and l.id is null))
     order by c.opened_at for update`,
    [carrierId]
  );
  const reusable = [...(open ? [open] : []), ...softRows, ...unsettled];
  const reused = new Set<string>();
  const { rows: scanRows } = await client.query(
    `select s.mobile_time_event_id, s.employee_id, s.occurred_at, s.received_at, s.cycle_id
     from bin_scans s
     where s.carrier_id = $1 and s.clock_trusted and (s.cycle_id is null or s.cycle_id = any($2::uuid[]))
     order by s.occurred_at, s.mobile_time_event_id`,
    [carrierId, reusable.map((r) => r.id)]
  );
  const scans: ScanRow[] = scanRows.map((r) => ({
    id: r.mobile_time_event_id,
    employeeId: r.employee_id,
    occurredAt: new Date(r.occurred_at).getTime(),
    receivedAt: new Date(r.received_at).getTime(),
    cycleId: r.cycle_id,
  }));

  // Boundaries from the earliest scan to place: weighings inside a period,
  // administrator closures, and period ends. Plus every unlinked pending
  // weighing inside a period (it still needs its reason and, after 24 h,
  // expiry).
  const from = scans.length ? new Date(scans[0].occurredAt) : null; // null: no scan to place
  const { rows: bRows } = await client.query(
    `select 'w' as kind, w.id, w.weighed_at as at, w.status, w.pending_until, w.match_reason, c.id as cycle_id
       from scale_weighings w left join bin_cycles c on c.weighing_id = w.id
       where w.carrier_id = $1 and not w.is_duplicate and ${IN_PERIOD("w.weighed_at")}
         and (w.weighed_at >= $2::timestamptz or (w.status = 'pending' and c.id is null))
     union all
     select 'u', null, c.closed_at, c.status, null, null, c.id
       from bin_cycles c
       where c.carrier_id = $1 and c.status = 'closed_unweighed' and c.closed_at >= $2::timestamptz
         and (c.closed_by_employee_id is not null or c.close_request_id is not null) -- administrator closures; stops are 's'
     union all
     select 's', p.id, p.stopped_at, null, null, null, null
       from bin_cycle_tracking p where p.stopped_at is not null and p.stopped_at >= $2::timestamptz
     order by at, kind desc`, // same instant: a weighing, then a closure, then a period end
    [carrierId, from]
  );
  const boundaries = bRows.map((r) => ({
    ...r,
    key: r.kind === "w" ? r.id : r.kind === "u" ? `u:${r.cycle_id}` : `s:${r.id}`,
    at: new Date(r.at).getTime(),
  }));
  const groups = placeScans(scans, boundaries);
  const byId = new Map(scans.map((s) => [s.id, s]));

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

  // The row a run keeps: the first not-yet-used open / stop-closed /
  // unsettled-superseded row owning any of its scans (stable identity), or a
  // new one.
  type Slot = { id: string; existing: any | null };
  const slotFor = (run: PlaceScan[]): Slot => {
    const r = reusable.find((x) => !reused.has(x.id) && run.some((s) => byId.get(s.id)!.cycleId === x.id));
    if (r) {
      reused.add(r.id);
      return { id: r.id, existing: r };
    }
    return { id: randomUUID(), existing: null };
  };

  interface CycleFields {
    status: CycleStatus;
    weighingId?: string | null;
    closedAt?: Date | null;
    closeReason?: string | null;
    supersededBy?: string | null;
    finalizedAt?: Date | null;
    reviewStatus?: string | null;
    awaitingSince?: Date | null;
    reviewReason?: string | null;
  }
  const writeCycle = async (slot: Slot, run: PlaceScan[], f: CycleFields, eventReason: string | null, weighingId: string | null = null) => {
    const opened = new Date(run[0].occurredAt);
    const last = new Date(run[run.length - 1].occurredAt);
    const vals = [
      slot.id,
      f.status,
      run[0].employeeId,
      opened,
      last,
      f.awaitingSince ?? null,
      f.reviewReason ?? null,
      f.weighingId ?? null,
      f.closedAt ?? null,
      f.closeReason ?? null,
      f.supersededBy ?? null,
      f.finalizedAt ?? null,
      f.reviewStatus ?? null,
    ];
    if (slot.existing) {
      const e = slot.existing;
      const same =
        e.status === f.status && e.employee_id === run[0].employeeId && +new Date(e.opened_at) === +opened && +new Date(e.last_scan_at) === +last &&
        (e.weighing_id ?? null) === (f.weighingId ?? null) && (e.superseded_by_cycle_id ?? null) === (f.supersededBy ?? null) &&
        (e.closed_at ? +new Date(e.closed_at) : null) === (f.closedAt ? +f.closedAt : null) &&
        (e.finalized_at ? 1 : 0) === (f.finalizedAt ? 1 : 0) && (e.review_reason ?? null) === (f.reviewReason ?? null) &&
        (e.awaiting_since ? +new Date(e.awaiting_since) : null) === (f.awaitingSince ? +f.awaitingSince : null);
      if (!same) {
        await client.query(
          `update bin_cycles set status = $2, employee_id = $3, opened_at = $4, last_scan_at = $5, awaiting_since = $6, review_reason = $7,
             weighing_id = $8, closed_at = $9, close_reason = $10, superseded_by_cycle_id = $11,
             finalized_at = case when $2 = 'superseded' then coalesce(finalized_at, $12) end,
             review_status = case when $2 = 'superseded' then coalesce(review_status, $13) end, updated_at = now()
           where id = $1`,
          vals
        );
        if (e.status !== f.status) {
          await cycleEvent(client, {
            cycleId: slot.id,
            kind: f.status === "closed" ? "weighed" : f.status === "superseded" ? "superseded" : "status",
            fromStatus: e.status,
            toStatus: f.status,
            weighingId,
            reason: eventReason,
            detail: f.supersededBy ? { supersededByCycleId: f.supersededBy } : undefined,
          });
        }
      }
    } else {
      await client.query(
        `insert into bin_cycles (id, status, employee_id, opened_at, last_scan_at, awaiting_since, review_reason, weighing_id, closed_at,
           close_reason, superseded_by_cycle_id, finalized_at, review_status, carrier_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [...vals, carrierId]
      );
      await cycleEvent(client, {
        cycleId: slot.id,
        kind: "opened",
        toStatus: f.status,
        employeeId: run[0].employeeId,
        mobileTimeEventId: run[0].id,
        weighingId,
        reason: eventReason,
        detail: f.supersededBy ? { supersededByCycleId: f.supersededBy } : undefined,
      });
    }
    await moveScans(slot.id, run, false);
  };

  // Earlier runs of an interval: superseded by the run after them.
  const writeSuperseded = async (runs: PlaceScan[][], slots: Slot[], settled: boolean) => {
    for (let i = 0; i < runs.length - 1; i++) {
      await writeCycle(
        slots[i],
        runs[i],
        {
          status: "superseded",
          closedAt: new Date(runs[i + 1][0].occurredAt),
          closeReason: SUPERSEDED_REASON,
          supersededBy: slots[i + 1].id,
          finalizedAt: settled ? now : null,
          reviewStatus: "open",
        },
        SUPERSEDED_REASON
      );
    }
  };

  for (const b of boundaries) {
    const group = groups.get(b.key) ?? [];
    if (b.kind === "s") {
      // Scans up to the end of a period with no weighing after them.
      if (group.length === 0) continue;
      const runs = splitRuns(group);
      const slots = runs.map(slotFor);
      const lastRun = runs[runs.length - 1];
      if (!slots[slots.length - 1].existing) {
        const { rows: existing } = await client.query(
          `select * from bin_cycles where carrier_id = $1 and status = 'closed_unweighed' and closed_by_employee_id is null
             and close_request_id is null and closed_at = $2 and not (id = any($3::uuid[])) order by opened_at limit 1`,
          [carrierId, new Date(b.at), [...reused]]
        );
        if (existing[0] && existing[0].employee_id === lastRun[0].employeeId) {
          reused.add(existing[0].id);
          slots[slots.length - 1] = { id: existing[0].id, existing: existing[0] };
        }
      }
      await writeSuperseded(runs, slots, true);
      const ls = slots[slots.length - 1];
      if (ls.existing && ls.existing.status === "closed_unweighed") {
        await moveScans(ls.id, lastRun, true);
      } else {
        await writeCycle(ls, lastRun, { status: "closed_unweighed", closedAt: new Date(b.at), closeReason: STOPPED_REASON }, STOPPED_REASON);
      }
      continue;
    }
    if (b.kind === "u") {
      if (group.length) await moveScans(b.cycle_id, group, true); // a closed cycle: late scans join it
      continue;
    }
    if (b.cycle_id) {
      // A weighed, final cycle: late scans never change its outcome. The
      // credited employee's join it; anyone else's become a superseded cycle
      // flagged for review (an administrator can credit it instead).
      if (group.length === 0) continue;
      const { rows: wr } = await client.query(
        `select w.status, w.employee_id, c.employee_id as cycle_employee_id from scale_weighings w join bin_cycles c on c.weighing_id = w.id where w.id = $1`,
        [b.id]
      );
      const owner = wr[0].status === "credited" ? wr[0].employee_id : wr[0].cycle_employee_id;
      for (const run of splitRuns(group)) {
        if (run[0].employeeId === owner) {
          await moveScans(b.cycle_id, run, true);
          if (wr[0].status === "credited") for (const s of run) await addClaim(client, s.id, b.id, s.employeeId);
          continue;
        }
        const slot = { id: randomUUID(), existing: null };
        await writeCycle(
          slot,
          run,
          { status: "superseded", closedAt: new Date(b.at), closeReason: LATE_SUPERSEDED_REASON, supersededBy: b.cycle_id, finalizedAt: now, reviewStatus: "open" },
          LATE_SUPERSEDED_REASON
        );
        if (wr[0].status === "credited" || wr[0].status === "needs_review") {
          for (const s of run) {
            const ins = await client.query(
              `insert into scale_weighing_flags (weighing_id, mobile_time_event_id, employee_id, kind) values ($1, $2, $3, $4)
               on conflict (weighing_id, mobile_time_event_id) do nothing`,
              [b.id, s.id, s.employeeId, wr[0].status === "credited" ? "late_conflict" : "competing"]
            );
            if (wr[0].status === "credited" && ins.rowCount === 1) {
              await weighingEvent(client, b.id, "late_conflict", null, null, s.employeeId,
                "Another employee's scan of this bin arrived after the credit. The credit is unchanged; flagged for review.", { mobileTimeEventId: s.id, binCycleId: slot.id });
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

    // The scans before this weighing: the latest run is the cycle it closes,
    // earlier runs are superseded (settled now the bin is weighed).
    const runs = splitRuns(group);
    const slots = runs.map(slotFor);
    await writeSuperseded(runs, slots, true);
    const lastRun = runs[runs.length - 1];
    const closer = slots[slots.length - 1];
    const closeReason = b.status === "pending" ? null : b.status === "expired" ? TOO_LATE_REASON : HELD_REASON;
    const fromStopped = closer.existing?.status === "closed_unweighed";
    await writeCycle(
      closer,
      lastRun,
      {
        status: "closed",
        weighingId: b.id,
        closedAt: new Date(b.at),
        closeReason,
        awaitingSince: closer.existing?.awaiting_since ? new Date(closer.existing.awaiting_since) : new Date(b.at),
      },
      fromStopped ? "Weighed before picking-cycle tracking stopped; the weighing reached LabourLink afterwards." : closeReason,
      b.id
    );
    if (b.status !== "pending") continue; // already final: never credited now
    const employee = lastRun[0].employeeId;
    for (const s of lastRun) await addClaim(client, s.id, b.id, employee);
    const supersededIds = slots.slice(0, -1).map((s) => s.id);
    await client.query(`update scale_weighings set status = 'credited', employee_id = $2, match_reason = $3, resolved_at = now() where id = $1 and status = 'pending'`, [
      b.id,
      employee,
      supersededIds.length ? CREDITED_LATEST_REASON : CREDITED_REASON,
    ]);
    await weighingEvent(client, b.id, "status", "pending", "credited", employee, supersededIds.length ? CREDITED_LATEST_REASON : CREDITED_REASON, {
      binCycleId: closer.id,
      mobileTimeEventIds: lastRun.map((s) => s.id),
      supersededCycleIds: supersededIds.length ? supersededIds : undefined,
    });
  }

  // Scans after the last boundary: the bin's current cycle, with any earlier
  // employees' cycles superseded (still re-placeable until the bin is weighed).
  const openGroup = groups.get("open") ?? [];
  if (openGroup.length === 0) return;
  const runs = splitRuns(openGroup);
  const slots = runs.map(slotFor);
  await writeSuperseded(runs, slots, false);
  const lastRun = runs[runs.length - 1];
  const f = await fillingState(client, carrierId, lastRun[0].employeeId, new Date(lastRun[0].occurredAt));
  await writeCycle(
    slots[slots.length - 1],
    lastRun,
    {
      status: f.filling ? "filling" : "awaiting_weighing",
      awaitingSince: f.filling ? null : f.awaitingSince ?? new Date(lastRun[lastRun.length - 1].occurredAt),
    },
    null
  );
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
    if (!(await trackingEverStarted(pool))) return;
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
// missed post-sync run left out, expires unlinked weighings, closes cycles
// left open by a stopped period, and refreshes every open cycle's filling /
// awaiting state (midnight cutoff, admin end).
export async function sweepBinCycles(now: Date = new Date()): Promise<void> {
  try {
    if (!(await trackingEverStarted(pool))) return;
    const bins = await recordBinScans(pool, { receivedSince: new Date(now.getTime() - 2 * PENDING_RECOVERY_MS) });
    const { rows } = await pool.query(
      `select carrier_id from bin_cycles where status = any($1::text[])
       union select carrier_id from bin_scans where cycle_id is null and clock_trusted
       union select w.carrier_id from scale_weighings w where w.status = 'pending' and ${IN_PERIOD("w.weighed_at")}`,
      [OPEN_STATUSES]
    );
    await reconcileBins([...bins, ...rows.map((r) => r.carrier_id)]);
  } catch (err) {
    console.error("[bin-cycles] sweep failed:", err instanceof Error ? err.message : err);
  }
}

type ActionResult = { ok: true; replay: boolean } | { ok: false; status: number; error: string; code: string };

// Administrator: close an open cycle without a weighing (bin emptied or
// abandoned). Nobody is credited for it; the bin's next scan starts a new
// cycle. Idempotent on requestId.
export async function closeCycleWithoutWeighing(cycleId: string, requestId: string, reason: string, actorEmployeeId: string): Promise<ActionResult> {
  const { rows: c0 } = await pool.query(`select carrier_id from bin_cycles where id = $1`, [cycleId]);
  if (!c0[0]) return { ok: false, status: 404, error: "Picking cycle not found", code: "notFound" };
  let result: ActionResult = { ok: true, replay: false };
  await inCarrierTransaction(c0[0].carrier_id, async (client) => {
    const { rows: done } = await client.query(`select id from bin_cycles where close_request_id = $1`, [requestId]);
    if (done[0]) {
      result = done[0].id === cycleId ? { ok: true, replay: true } : { ok: false, status: 409, error: "This request was already used for another cycle", code: "requestReused" };
      return;
    }
    // Place anything that arrived first, so the closure covers the cycle as it is now.
    await reconcileBinCyclesLocked(client, c0[0].carrier_id);
    const { rows } = await client.query(`select status from bin_cycles where id = $1 for update`, [cycleId]);
    if (!(OPEN_STATUSES as readonly string[]).includes(rows[0].status)) {
      result = { ok: false, status: 409, error: "Only an open picking cycle can be closed", code: "notOpen" };
      return;
    }
    await client.query(
      `update bin_cycles set status = 'closed_unweighed', closed_at = now(), close_reason = $2, closed_by_employee_id = $3, close_request_id = $4, updated_at = now() where id = $1`,
      [cycleId, reason, actorEmployeeId, requestId]
    );
    await cycleEvent(client, { cycleId, kind: "closed_unweighed", fromStatus: rows[0].status, toStatus: "closed_unweighed", actorEmployeeId, reason });
    // Earlier employees' cycles superseded before this one are settled too.
    await client.query(`update bin_cycles set finalized_at = now(), updated_at = now() where carrier_id = $1 and status = 'superseded' and finalized_at is null`, [c0[0].carrier_id]);
  });
  return result;
}

// Administrator: a weighed cycle that more than one employee chose (its
// weighing is needs_review) is credited to the employee the administrator
// selects, who must be one of the cycle's scanners. The weighing becomes
// credited exactly once (guarded on its status, under the bin lock); the
// cycle records who resolved it, when, why and the previous status. After
// that the cycle is final like any other: late phone scans and background
// reconciliation never change the credit, and the credit can still be voided.
// Idempotent on requestId.
export async function resolveCycle(cycleId: string, requestId: string, employeeId: string, reason: string, actorEmployeeId: string): Promise<ActionResult> {
  const { rows: c0 } = await pool.query(`select carrier_id from bin_cycles where id = $1`, [cycleId]);
  if (!c0[0]) return { ok: false, status: 404, error: "Picking cycle not found", code: "notFound" };
  let result: ActionResult = { ok: true, replay: false };
  await inCarrierTransaction(c0[0].carrier_id, async (client) => {
    const { rows: done } = await client.query(`select id, resolved_employee_id from bin_cycles where resolution_request_id = $1`, [requestId]);
    if (done[0]) {
      result =
        done[0].id === cycleId && done[0].resolved_employee_id === employeeId
          ? { ok: true, replay: true }
          : { ok: false, status: 409, error: "This request was already used for a different resolution", code: "requestReused" };
      return;
    }
    await reconcileBinCyclesLocked(client, c0[0].carrier_id); // place late scans first
    const { rows } = await client.query(
      `select c.status, c.weighing_id, c.resolved_at, w.status as weighing_status
       from bin_cycles c left join scale_weighings w on w.id = c.weighing_id where c.id = $1 for update of c`,
      [cycleId]
    );
    const c = rows[0];
    if (c.resolved_at) {
      result = { ok: false, status: 409, error: "This picking cycle was already resolved", code: "alreadyResolved" };
      return;
    }
    if (c.status !== "closed" || !c.weighing_id) {
      result = { ok: false, status: 409, error: "Only a weighed picking cycle can be resolved. Resolve it after the bin is weighed.", code: "notWeighed" };
      return;
    }
    if (c.weighing_status !== "needs_review") {
      result = { ok: false, status: 409, error: "This cycle's weighing is not waiting for review", code: "notInReview" };
      return;
    }
    const { rows: scanners } = await client.query(`select 1 from bin_scans where cycle_id = $1 and employee_id = $2 limit 1`, [cycleId, employeeId]);
    if (!scanners[0]) {
      result = { ok: false, status: 422, error: "Choose one of the employees who scanned this bin in this cycle", code: "notInCycle" };
      return;
    }
    const upd = await client.query(
      `update scale_weighings set status = 'credited', employee_id = $2, match_reason = $3, resolved_at = now()
       where id = $1 and status = 'needs_review' and not is_duplicate`,
      [c.weighing_id, employeeId, `Resolved by an administrator: ${reason}`]
    );
    if (upd.rowCount !== 1) {
      result = { ok: false, status: 409, error: "This cycle's weighing can't be credited", code: "notInReview" };
      return;
    }
    const { rows: scans } = await client.query(`select mobile_time_event_id from bin_scans where cycle_id = $1 and employee_id = $2`, [cycleId, employeeId]);
    for (const s of scans) await addClaim(client, s.mobile_time_event_id, c.weighing_id, employeeId);
    await client.query(
      `update bin_cycles set resolved_employee_id = $2, resolved_by_employee_id = $3, resolved_at = now(), resolution_reason = $4,
         resolution_previous_status = 'needs_review', resolution_request_id = $5, updated_at = now() where id = $1`,
      [cycleId, employeeId, actorEmployeeId, reason, requestId]
    );
    await cycleEvent(client, { cycleId, kind: "resolved", fromStatus: "needs_review", toStatus: "credited", employeeId, actorEmployeeId, weighingId: c.weighing_id, reason });
    await weighingEvent(client, c.weighing_id, "resolve", "needs_review", "credited", employeeId, reason, { binCycleId: cycleId }, actorEmployeeId);
  });
  return result;
}

// Administrator review of a superseded cycle (075).
// * confirm: it really was superseded; the review is closed.
// * reinstate: the bin's weighing is credited to this cycle's employee
//   instead of the cycle that superseded it (a mistaken or accidental scan).
//   The weighing keeps its weights and time; its credit moves once, in one
//   transaction under the bin lock; the cycle that had it becomes superseded;
//   the claims behind the credit are replaced. Only for a credited (not
//   voided) weighing. The credit can still be voided afterwards.
// Idempotent on requestId (bin_cycle_reviews is the audit record).
export async function reviewSupersededCycle(
  cycleId: string,
  requestId: string,
  action: "reinstate" | "confirm",
  reason: string,
  actorEmployeeId: string
): Promise<ActionResult & { weighingId?: string }> {
  const { rows: c0 } = await pool.query(`select carrier_id from bin_cycles where id = $1`, [cycleId]);
  if (!c0[0]) return { ok: false, status: 404, error: "Picking cycle not found", code: "notFound" };
  let result: ActionResult & { weighingId?: string } = { ok: true, replay: false };
  await inCarrierTransaction(c0[0].carrier_id, async (client) => {
    const { rows: done } = await client.query(`select cycle_id, action, weighing_id from bin_cycle_reviews where request_id = $1`, [requestId]);
    if (done[0]) {
      result =
        done[0].cycle_id === cycleId && done[0].action === action
          ? { ok: true, replay: true, weighingId: done[0].weighing_id ?? undefined }
          : { ok: false, status: 409, error: "This request was already used for a different review", code: "requestReused" };
      return;
    }
    await reconcileBinCyclesLocked(client, c0[0].carrier_id); // place delayed events first
    const { rows } = await client.query(`select * from bin_cycles where id = $1 for update`, [cycleId]);
    const s = rows[0];
    if (s.status !== "superseded") {
      result = { ok: false, status: 409, error: "Only a superseded picking cycle can be reviewed", code: "notSuperseded" };
      return;
    }
    if (action === "confirm") {
      if (s.review_status !== "open") {
        result = { ok: false, status: 409, error: "This superseded cycle was already reviewed", code: "alreadyReviewed" };
        return;
      }
      await client.query(`update bin_cycles set review_status = 'confirmed', updated_at = now() where id = $1`, [cycleId]);
      await client.query(
        `insert into bin_cycle_reviews (request_id, cycle_id, action, reason, performed_by_employee_id) values ($1, $2, 'confirm', $3, $4)`,
        [requestId, cycleId, reason, actorEmployeeId]
      );
      await cycleEvent(client, { cycleId, kind: "review_confirmed", fromStatus: "superseded", toStatus: "superseded", actorEmployeeId, reason });
      return;
    }
    if (!s.finalized_at) {
      result = { ok: false, status: 409, error: "This bin has not been weighed yet. Review it after the weighing.", code: "notWeighed" };
      return;
    }
    // Follow the chain to the cycle that holds the weighing.
    let cur = s;
    let closer: any = null;
    for (let i = 0; i < 100 && cur.superseded_by_cycle_id; i++) {
      const { rows: n } = await client.query(`select * from bin_cycles where id = $1 for update`, [cur.superseded_by_cycle_id]);
      if (!n[0]) break;
      if (n[0].status === "closed") {
        closer = n[0];
        break;
      }
      if (n[0].status !== "superseded") break;
      cur = n[0];
    }
    if (!closer?.weighing_id) {
      result = { ok: false, status: 409, error: "This bin's cycle was closed without a weighing, so there is no credit to move", code: "noWeighing" };
      return;
    }
    const { rows: wr } = await client.query(`select id, status, employee_id from scale_weighings where id = $1 for update`, [closer.weighing_id]);
    const w = wr[0];
    if (w.status !== "credited") {
      result = {
        ok: false,
        status: 409,
        error: w.status === "voided" ? "That weighing's credit was voided" : "That weighing is not credited, so there is no credit to move",
        code: w.status === "voided" ? "voided" : "notCredited",
      };
      return;
    }
    const note = "Credit moved by an administrator to an earlier picking cycle";
    await client.query(
      `update bin_cycles set status = 'superseded', weighing_id = null, superseded_by_cycle_id = $2, review_status = 'confirmed',
         finalized_at = coalesce(finalized_at, now()), close_reason = $3, updated_at = now() where id = $1`,
      [closer.id, cycleId, note]
    );
    await client.query(
      `update bin_cycles set status = 'closed', weighing_id = $2, superseded_by_cycle_id = null, review_status = 'reinstated', close_reason = null, updated_at = now() where id = $1`,
      [cycleId, w.id]
    );
    await client.query(`delete from scale_weighing_claims where weighing_id = $1`, [w.id]);
    const { rows: sc } = await client.query(`select mobile_time_event_id from bin_scans where cycle_id = $1`, [cycleId]);
    for (const x of sc) await addClaim(client, x.mobile_time_event_id, w.id, s.employee_id);
    const upd = await client.query(
      `update scale_weighings set employee_id = $2, match_reason = $3, resolved_at = now() where id = $1 and status = 'credited'`,
      [w.id, s.employee_id, `Credited by an administrator to an earlier picking cycle: ${reason}`]
    );
    if (upd.rowCount !== 1) throw new Error("weighing changed during review");
    await client.query(
      `insert into bin_cycle_reviews (request_id, cycle_id, action, weighing_id, previous_employee_id, new_employee_id, reason, performed_by_employee_id)
       values ($1, $2, 'reinstate', $3, $4, $5, $6, $7)`,
      [requestId, cycleId, w.id, w.employee_id, s.employee_id, reason, actorEmployeeId]
    );
    await cycleEvent(client, { cycleId, kind: "reinstated", fromStatus: "superseded", toStatus: "closed", employeeId: s.employee_id, actorEmployeeId, weighingId: w.id, reason });
    await cycleEvent(client, { cycleId: closer.id, kind: "superseded", fromStatus: "closed", toStatus: "superseded", employeeId: closer.employee_id, actorEmployeeId, weighingId: w.id, reason: note });
    await weighingEvent(client, w.id, "reassign", "credited", "credited", s.employee_id, reason, { binCycleId: cycleId, previousEmployeeId: w.employee_id, previousBinCycleId: closer.id }, actorEmployeeId);
    result = { ok: true, replay: false, weighingId: w.id };
  });
  return result;
}
