// Database side of weighing assignment: loads claims, applies the pure rule
// in scaleMatchingRule.ts (read that header first) and records the outcome.
import { PoolClient } from "pg";
import { pool } from "../db";
import { Claim, cycleStart, decide, WeighingFacts } from "./scaleMatchingRule";

export * from "./scaleMatchingRule";

// Serializes all matching for one bin: a weighing arriving and a phone sync
// landing at the same moment can't both credit from the same evidence.
export async function lockCarrier(client: PoolClient, carrierId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtext('scale-carrier:' || $1::text))`, [carrierId]);
}

// Accepted bin-choosing phone events for `carrierId` in (start, end]. The
// answers may arrive as an object keyed by question id or as an array, so
// both shapes are matched. Clock flags are the keys detectClockAnomaly
// (routes/mobileTime.ts) writes into conflict_detail.
async function loadClaims(client: PoolClient, carrierId: string, start: Date, end: Date): Promise<Claim[]> {
  const { rows } = await client.query(
    `select m.id, m.employee_id, m.occurred_at_utc, m.received_at,
            coalesce(m.conflict_detail ? 'forwardSkewMs' or m.conflict_detail ? 'regressionMs', false) as clock_flagged,
            c.weighing_id as consumed_by
     from mobile_time_events m
     left join scale_weighing_claims c on c.mobile_time_event_id = m.id
     where m.processing_status = 'accepted'
       and m.event_type in ('work_start', 'activity_switch')
       and m.occurred_at_utc > $2 and m.occurred_at_utc <= $3
       and (jsonb_path_exists(m.payload, '$.answers.* ? (@.carrierId == $c)', jsonb_build_object('c', $1::text))
         or jsonb_path_exists(m.payload, '$.answers[*] ? (@.carrierId == $c)', jsonb_build_object('c', $1::text)))
     order by m.occurred_at_utc, m.id`,
    [carrierId, start, end]
  );
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    occurredAt: new Date(r.occurred_at_utc).getTime(),
    receivedAt: new Date(r.received_at).getTime(),
    clockTrusted: !r.clock_flagged,
    consumedBy: r.consumed_by ?? null,
  }));
}

export async function recordWeighingEvent(
  client: PoolClient,
  e: {
    weighingId: string;
    kind: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    employeeId?: string | null;
    actorEmployeeId?: string | null;
    reason?: string | null;
    detail?: unknown;
  }
): Promise<void> {
  await client.query(
    `insert into scale_weighing_events (weighing_id, kind, from_status, to_status, employee_id, actor_employee_id, reason, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.weighingId,
      e.kind,
      e.fromStatus ?? null,
      e.toStatus ?? null,
      e.employeeId ?? null,
      e.actorEmployeeId ?? null,
      e.reason ?? null,
      e.detail === undefined ? null : JSON.stringify(e.detail),
    ]
  );
}

const MATCH_REASONS: Record<string, string> = {
  credited: "One employee chose this bin on their phone during this bin use",
  needs_review: "More than one employee chose this bin during this bin use",
  expired: "No phone bin choice arrived within 24 hours of the weighing",
};

// Re-evaluates one weighing. The caller must hold lockCarrier() for its bin
// inside an open transaction.
export async function reconcileWeighingLocked(client: PoolClient, weighingId: string, now: Date = new Date()): Promise<void> {
  const { rows } = await client.query(
    `select w.id, w.carrier_id, w.weighed_at, w.status, w.employee_id,
            (select max(p.weighed_at) from scale_weighings p
              where p.carrier_id = w.carrier_id and p.weighed_at < w.weighed_at) as previous_weighed_at
     from scale_weighings w where w.id = $1 for update`,
    [weighingId]
  );
  const row = rows[0];
  if (!row || (row.status !== "pending" && row.status !== "credited")) return;

  const facts: WeighingFacts = {
    id: row.id,
    weighedAt: new Date(row.weighed_at).getTime(),
    previousWeighedAt: row.previous_weighed_at ? new Date(row.previous_weighed_at).getTime() : null,
    current: row.status,
    currentEmployeeId: row.employee_id,
  };
  const claims = await loadClaims(client, row.carrier_id, new Date(cycleStart(facts)), new Date(facts.weighedAt));
  const d = decide(facts, claims, now.getTime());
  const byId = new Map(claims.map((c) => [c.id, c]));

  for (const id of d.consume) {
    await client.query(
      `insert into scale_weighing_claims (mobile_time_event_id, weighing_id, employee_id) values ($1, $2, $3)
       on conflict (mobile_time_event_id) do nothing`,
      [id, row.id, byId.get(id)!.employeeId]
    );
  }
  for (const [kind, ids] of [["competing", d.competing], ["late_conflict", d.conflicts]] as const) {
    for (const id of ids) {
      const inserted = await client.query(
        `insert into scale_weighing_flags (weighing_id, mobile_time_event_id, employee_id, kind) values ($1, $2, $3, $4)
         on conflict (weighing_id, mobile_time_event_id) do nothing`,
        [row.id, id, byId.get(id)!.employeeId, kind]
      );
      if (kind === "late_conflict" && inserted.rowCount === 1) {
        await recordWeighingEvent(client, {
          weighingId: row.id,
          kind: "late_conflict",
          employeeId: byId.get(id)!.employeeId,
          reason: "Another employee chose this bin during a bin use that was already credited. The credit is unchanged.",
          detail: { mobileTimeEventId: id },
        });
      }
    }
  }

  if (d.status !== row.status) {
    await client.query(
      `update scale_weighings set status = $2, employee_id = $3, match_reason = $4, resolved_at = now() where id = $1`,
      [row.id, d.status, d.employeeId, MATCH_REASONS[d.status] ?? null]
    );
    await recordWeighingEvent(client, {
      weighingId: row.id,
      kind: "status",
      fromStatus: row.status,
      toStatus: d.status,
      employeeId: d.employeeId,
      reason: MATCH_REASONS[d.status] ?? null,
      detail: d.consume.length || d.competing.length ? { mobileTimeEventIds: [...d.consume, ...d.competing] } : undefined,
    });
  }
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function reconcileWeighings(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { rows } = await pool.query(
    `select id, carrier_id from scale_weighings where id = any($1::uuid[]) and status in ('pending', 'credited')`,
    [ids]
  );
  for (const r of rows) {
    await inTransaction(async (client) => {
      await lockCarrier(client, r.carrier_id);
      await reconcileWeighingLocked(client, r.id);
    });
  }
}

export function scaleMatchingEnabled(): boolean {
  return process.env.SCALE_MATCHING_ENABLED !== "false";
}

// Carrier ids chosen in a synced phone event's answers (object or array).
export function carrierIdsInAnswers(answers: unknown): string[] {
  if (!answers || typeof answers !== "object") return [];
  const values = Array.isArray(answers) ? answers : Object.values(answers as Record<string, unknown>);
  const ids = new Set<string>();
  for (const v of values) {
    const id = (v as { carrierId?: unknown } | null)?.carrierId;
    if (typeof id === "string") ids.add(id);
  }
  return [...ids];
}

// After a phone sync: for each newly accepted bin choice, re-evaluate the
// weighing whose cycle it falls in (the bin's first weighing at or after the
// event). Runs after the sync response is sent, each weighing in its own
// transaction; it never throws, so it can't affect phone sync.
export async function reconcileAfterPhoneSync(deviceId: string, clientEventIds: string[]): Promise<void> {
  if (!scaleMatchingEnabled() || clientEventIds.length === 0) return;
  try {
    const { rows } = await pool.query(
      `select distinct w.id
       from mobile_time_events m
       cross join lateral (
         select a->>'carrierId' as carrier_id
         from jsonb_path_query(m.payload, '$.answers.*') a where jsonb_typeof(a) = 'object' and a ? 'carrierId'
         union
         select a->>'carrierId'
         from jsonb_path_query(m.payload, '$.answers[*]') a where jsonb_typeof(a) = 'object' and a ? 'carrierId'
       ) chosen
       join lateral (
         select sw.id, sw.carrier_id from scale_weighings sw
         where sw.carrier_id::text = chosen.carrier_id and sw.weighed_at >= m.occurred_at_utc
         order by sw.weighed_at limit 1
       ) w on true
       where m.device_id = $1 and m.client_event_id = any($2::uuid[])
         and m.processing_status = 'accepted' and m.event_type in ('work_start', 'activity_switch')`,
      [deviceId, clientEventIds]
    );
    await reconcileWeighings(rows.map((r) => r.id));
  } catch (err) {
    console.error("[scale-matching] reconcile after phone sync failed:", err instanceof Error ? err.message : err);
  }
}

// Safety net for a missed post-sync run (e.g. a deploy restarted the API in
// between) and for expiring weighings nobody asked about: every pending
// weighing is re-evaluated. Never throws.
export async function sweepPendingWeighings(): Promise<number> {
  if (!scaleMatchingEnabled()) return 0;
  try {
    const { rows } = await pool.query(`select id from scale_weighings where status = 'pending' order by weighed_at limit 500`);
    await reconcileWeighings(rows.map((r) => r.id));
    return rows.length;
  } catch (err) {
    console.error("[scale-matching] sweep failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startScaleMatchingSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepPendingWeighings();
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
