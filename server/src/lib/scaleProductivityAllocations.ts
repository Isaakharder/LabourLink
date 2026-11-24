// Administrator review of how weighed bins' kilograms are allocated for
// kg/hour (078_scale_productivity_allocations.sql). PRODUCTIVITY REPORTING
// ONLY: nothing here reads or writes an official scale credit, a weighing, a
// picking cycle, a time entry or pay; it writes only the three 078 tables.
//
// Decisions:
//   confirm   the calculated proportional allocation is right
//   override  exclude contributions (accidental scans, emptied loads), and
//             optionally set each included employee's kilograms by hand
//             (they must add up to the net weight to the gram)
//   exclude   the bin counts for nobody's kg/hour
//   reset     remove the decision: the bin is decided by the rules again
//
// Concurrency: every request names the version it was made on (the number of
// decisions so far for this bin and Job) and the fingerprint of the records
// it was shown. Under a per-bin lock, a stale version or changed records
// answer 409, so two administrators can never overwrite each other unseen
// and a decision is never made on records that have since changed.
// Idempotent on requestId (the history row is the audit record).
import { PoolClient } from "pg";
import { pool } from "../db";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "./timezone";
import { allocateGrams, BIN_EXCLUSION_LABELS, BinExclusionReason, evaluateLoads, LoadOutcome } from "./scaleProductivity";

type Db = PoolClient | typeof pool;
const fullName = (alias: string) => `trim(${alias}.first_name || ' ' || coalesce(${alias}.last_name, ''))`;

export type AllocationStatus = "single" | "shared_auto" | "review" | "reviewed" | "manual" | "excluded";

export async function scaleKgJobs(db: Db = pool): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query(`select id, name from activities where productivity_metric = 'scale_kg' order by name`);
  return rows;
}

function statusOf(o: LoadOutcome): AllocationStatus {
  if (o.kind === "review") return "review";
  if (o.kind === "excluded") return "excluded";
  if (o.kind === "allocated") return o.basis === "manual" ? "manual" : o.basis === "reviewed_proportional" ? "reviewed" : o.basis;
  return "excluded";
}

async function names(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query(`select e.id, ${fullName("e")} as name from employees e where e.id = any($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

// The calculated proportional allocation and, when decided or automatic, the
// allocation that counts, per contributor.
function contributorRows(o: Exclude<LoadOutcome, { kind: "other_job_only" }>, nameOf: Map<string, string>) {
  const eff = o.contributors.filter((c) => c.matchedMs > 0);
  const totalMs = eff.reduce((s, c) => s + c.matchedMs, 0);
  const proposed = allocateGrams(o.load.netGrams, eff.map((c) => ({ employeeId: c.employeeId, weight: c.matchedMs })));
  const counted = o.kind === "allocated" ? new Map(o.shares.map((s) => [s.employeeId, s.grams])) : null;
  return o.contributors.map((c) => ({
    employeeId: c.employeeId,
    name: nameOf.get(c.employeeId) ?? "",
    matchedMinutes: Math.round(c.matchedMs / 600) / 100,
    matchedSeconds: Math.round(c.matchedMs / 1000),
    percent: totalMs > 0 ? Math.round((c.matchedMs / totalMs) * 10000) / 100 : 0,
    proposedKg: (proposed.get(c.employeeId) ?? 0) / 1000,
    countedKg: counted ? (counted.get(c.employeeId) ?? 0) / 1000 : null,
    counted: counted ? counted.has(c.employeeId) : false,
    scanned: c.scanned,
    otherJobMinutes: Math.round(c.otherJobMs / 600) / 100,
    firstAt: c.intervals.length ? new Date(c.intervals[0][0]).toISOString() : null,
    lastAt: c.intervals.length ? new Date(c.intervals[c.intervals.length - 1][1]).toISOString() : null,
  }));
}

function reasonsOf(o: LoadOutcome): { code: BinExclusionReason; label: string }[] {
  const list: BinExclusionReason[] = o.kind === "review" ? o.reasons : o.kind === "excluded" ? [o.reason] : [];
  return list.map((code) => ({ code, label: BIN_EXCLUSION_LABELS[code] }));
}

// Bins of one local weighing day worth showing an administrator: shared
// (more than one employee picked into it), waiting for review, decided, or
// excluded by an administrator. Single-employee bins counted by the rules
// are left out.
export async function listAllocations(jobId: string, date: string) {
  const { start, end } = getDayBoundsUtc(date);
  const outcomes = (await evaluateLoads(jobId, { start: new Date(start), end: new Date(end) })).filter(
    (o): o is Exclude<LoadOutcome, { kind: "other_job_only" }> => o.kind !== "other_job_only"
  );
  const { rows: decided } = await pool.query(`select weighing_id from scale_productivity_allocations where activity_id = $1 and weighing_id = any($2::uuid[])`, [
    jobId,
    outcomes.map((o) => o.load.weighingId),
  ]);
  const hasDecision = new Set(decided.map((r) => r.weighing_id as string));
  const shown = outcomes.filter(
    (o) =>
      o.kind === "review" ||
      hasDecision.has(o.load.weighingId) ||
      o.contributors.filter((c) => c.matchedMs > 0).length > 1 ||
      (o.kind === "excluded" && o.reason === "excluded_by_admin")
  );
  const ids = [...new Set(shown.flatMap((o) => [...o.contributors.map((c) => c.employeeId), o.load.creditedEmployeeId]))];
  const nameOf = await names(pool, ids);
  const { rows: bins } = await pool.query(`select id, name from carriers where id = any($1::uuid[])`, [shown.map((o) => o.load.carrierId)]);
  const binName = new Map(bins.map((r) => [r.id, r.name]));
  return shown
    .sort((a, b) => a.load.weighedAt - b.load.weighedAt)
    .map((o) => ({
      weighingId: o.load.weighingId,
      bin: binName.get(o.load.carrierId) ?? "",
      weighedAt: new Date(o.load.weighedAt).toISOString(),
      netKg: o.load.netGrams / 1000,
      officialCredit: { id: o.load.creditedEmployeeId, name: nameOf.get(o.load.creditedEmployeeId) ?? "" },
      status: statusOf(o),
      decided: hasDecision.has(o.load.weighingId),
      reasons: reasonsOf(o),
      contributors: contributorRows(o, nameOf).filter((c) => c.matchedSeconds > 0 || c.scanned),
    }));
}

async function versionOf(db: Db, weighingId: string, jobId: string): Promise<number> {
  const { rows } = await db.query(`select count(*)::int as n from scale_productivity_allocation_history where weighing_id = $1 and activity_id = $2`, [weighingId, jobId]);
  return rows[0].n;
}

async function currentDecision(db: Db, weighingId: string, jobId: string) {
  const { rows } = await db.query(
    `select a.action, a.method, a.reason, a.net_g, a.inputs_fingerprint, a.decided_at, a.decided_by_employee_id,
            coalesce(json_agg(json_build_object('employeeId', s.employee_id, 'included', s.included, 'matchedSeconds', s.matched_seconds, 'allocatedGrams', s.allocated_g)
                     order by s.employee_id) filter (where s.employee_id is not null), '[]'::json) as shares
     from scale_productivity_allocations a
     left join scale_productivity_allocation_shares s on s.weighing_id = a.weighing_id
     where a.weighing_id = $1 and a.activity_id = $2
     group by a.weighing_id`,
    [weighingId, jobId]
  );
  return rows[0] ?? null;
}

export async function getAllocationDetail(jobId: string, weighingId: string) {
  const { rows: wr } = await pool.query(
    `select w.id, w.net_g, w.gross_g, w.tare_g, w.weighed_at, w.status, w.credits_live, w.is_duplicate, w.employee_id, c.name as bin
     from scale_weighings w left join carriers c on c.id = w.carrier_id where w.id = $1`,
    [weighingId]
  );
  const w = wr[0];
  if (!w) return null;
  const [o] = await evaluateLoads(jobId, { weighingIds: [weighingId] });
  const decision = await currentDecision(pool, weighingId, jobId);
  const { rows: history } = await pool.query(
    `select h.id, h.action, h.reason, h.previous, h.next, h.proposal, h.performed_at, ${fullName("e")} as performed_by
     from scale_productivity_allocation_history h join employees e on e.id = h.performed_by_employee_id
     where h.weighing_id = $1 and h.activity_id = $2 order by h.performed_at, h.id`,
    [weighingId, jobId]
  );
  const ids = [w.employee_id, ...(o && o.kind !== "other_job_only" ? o.contributors.map((c) => c.employeeId) : []), decision?.decided_by_employee_id].filter(Boolean);
  const nameOf = await names(pool, ids);
  const base = {
    weighingId,
    bin: w.bin ?? "",
    weighedAt: new Date(w.weighed_at).toISOString(),
    netKg: Number(w.net_g) / 1000,
    grossKg: Number(w.gross_g) / 1000,
    tareKg: Number(w.tare_g) / 1000,
    weighingStatus: w.status as string,
    officialCredit: w.employee_id ? { id: w.employee_id, name: nameOf.get(w.employee_id) ?? "" } : null,
    version: await versionOf(pool, weighingId, jobId),
    decision: decision
      ? {
          action: decision.action,
          method: decision.method,
          reason: decision.reason,
          decidedAt: new Date(decision.decided_at).toISOString(),
          decidedBy: nameOf.get(decision.decided_by_employee_id) ?? "",
          shares: (decision.shares as any[]).map((s) => ({ ...s, name: nameOf.get(s.employeeId) ?? "", allocatedKg: s.allocatedGrams / 1000 })),
        }
      : null,
    history: history.map((h) => ({ ...h, performed_at: new Date(h.performed_at).toISOString() })),
  };
  if (!o || o.kind === "other_job_only") {
    // Not a credited bin of this Job (voided, not credited, duplicate, or
    // all of its time under another Job): nothing to allocate.
    return { ...base, allocatable: false, status: "excluded" as AllocationStatus, reasons: [], contributors: [], fingerprint: null, loadStart: null };
  }
  const allocatable = !(o.kind === "excluded" && (o.reason === "no_cycle" || o.reason === "no_matched_time"));
  return {
    ...base,
    allocatable,
    status: statusOf(o),
    basis: o.kind === "allocated" ? o.basis : null,
    reasons: reasonsOf(o),
    contributors: contributorRows(o, nameOf),
    fingerprint: o.fingerprint,
    loadStart: new Date(o.load.loadStart).toISOString(),
  };
}

export type DecisionAction = "confirm" | "override" | "exclude" | "reset";
export interface DecisionRequest {
  weighingId: string;
  jobId: string;
  requestId: string;
  action: DecisionAction;
  reason: string;
  expectedVersion: number;
  expectedFingerprint: string;
  shares?: { employeeId: string; included: boolean; allocatedKg?: number | null }[];
}
export type DecisionResult = { ok: true; replay: boolean; version: number } | { ok: false; status: number; error: string; code: string };

export async function decideAllocation(r: DecisionRequest, actorEmployeeId: string): Promise<DecisionResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext('scale-productivity-allocation:' || $1::text))`, [r.weighingId]);
    const out = await decideLocked(client, r, actorEmployeeId);
    await client.query(out.ok ? "commit" : "rollback");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function decideLocked(client: PoolClient, r: DecisionRequest, actor: string): Promise<DecisionResult> {
  const { rows: done } = await client.query(`select weighing_id, action from scale_productivity_allocation_history where request_id = $1`, [r.requestId]);
  if (done[0]) {
    return done[0].weighing_id === r.weighingId && done[0].action === r.action
      ? { ok: true, replay: true, version: await versionOf(client, r.weighingId, r.jobId) }
      : { ok: false, status: 409, error: "This request was already used for a different decision", code: "requestReused" };
  }
  const version = await versionOf(client, r.weighingId, r.jobId);
  if (version !== r.expectedVersion) {
    return { ok: false, status: 409, error: "Someone else changed this allocation. Reload to see the latest.", code: "staleVersion" };
  }
  const [o] = await evaluateLoads(r.jobId, { weighingIds: [r.weighingId] }, client);
  if (!o || o.kind === "other_job_only") return { ok: false, status: 409, error: "This weighing is not a credited bin of this job", code: "notAllocatable" };
  if (o.kind === "excluded" && (o.reason === "no_cycle" || o.reason === "no_matched_time")) {
    return { ok: false, status: 409, error: "No picking time matches this bin, so there is nothing to allocate", code: "notAllocatable" };
  }
  if (o.fingerprint !== r.expectedFingerprint) {
    return { ok: false, status: 409, error: "The time records for this bin changed. Reload to see the latest.", code: "inputsChanged" };
  }
  const eff = o.contributors.filter((c) => c.matchedMs > 0);
  const previous = await currentDecision(client, r.weighingId, r.jobId);
  const proposalGrams = allocateGrams(o.load.netGrams, eff.map((c) => ({ employeeId: c.employeeId, weight: c.matchedMs })));
  const proposal = {
    netGrams: o.load.netGrams,
    loadStart: new Date(o.load.loadStart).toISOString(),
    status: statusOf(o),
    reasons: reasonsOf(o).map((x) => x.code),
    contributors: eff.map((c) => ({ employeeId: c.employeeId, matchedSeconds: Math.round(c.matchedMs / 1000), proposedGrams: proposalGrams.get(c.employeeId) ?? 0 })),
  };

  let next: { action: "confirm" | "override" | "exclude"; method: "proportional" | "manual" | null; shares: { employeeId: string; included: boolean; matchedSeconds: number; allocatedGrams: number }[] } | null = null;
  if (r.action === "reset") {
    if (!previous) return { ok: false, status: 409, error: "There is no decision to reset", code: "nothingToReset" };
  } else if (r.action === "exclude") {
    next = { action: "exclude", method: null, shares: [] };
  } else if (r.action === "confirm") {
    next = {
      action: "confirm",
      method: "proportional",
      shares: eff.map((c) => ({ employeeId: c.employeeId, included: true, matchedSeconds: Math.round(c.matchedMs / 1000), allocatedGrams: proposalGrams.get(c.employeeId) ?? 0 })),
    };
  } else {
    const given = r.shares ?? [];
    const effIds = new Set(eff.map((c) => c.employeeId));
    const seen = new Set<string>();
    for (const s of given) {
      if (!effIds.has(s.employeeId)) return { ok: false, status: 422, error: "Every share must be one of this bin's contributing employees", code: "unknownEmployee" };
      if (seen.has(s.employeeId)) return { ok: false, status: 422, error: "An employee is listed twice", code: "duplicateEmployee" };
      seen.add(s.employeeId);
    }
    if (seen.size !== effIds.size) return { ok: false, status: 422, error: "Include or exclude every contributing employee", code: "missingEmployee" };
    const included = given.filter((s) => s.included);
    if (!included.length) return { ok: false, status: 422, error: "Include at least one employee, or exclude the whole bin", code: "nobodyIncluded" };
    const manual = given.some((s) => s.included && s.allocatedKg != null);
    let grams: Map<string, number>;
    if (manual) {
      if (included.some((s) => s.allocatedKg == null || !Number.isFinite(s.allocatedKg) || s.allocatedKg < 0)) {
        return { ok: false, status: 422, error: "Enter kilograms for every included employee", code: "invalidKg" };
      }
      grams = new Map(included.map((s) => [s.employeeId, Math.round((s.allocatedKg as number) * 1000)]));
      const sum = [...grams.values()].reduce((a, b) => a + b, 0);
      if (sum !== o.load.netGrams) {
        return {
          ok: false,
          status: 422,
          error: `The kilograms must add up to the bin's net ${(o.load.netGrams / 1000).toFixed(3)} kg (they add up to ${(sum / 1000).toFixed(3)} kg)`,
          code: "sumMismatch",
        };
      }
    } else {
      const inc = new Set(included.map((s) => s.employeeId));
      grams = allocateGrams(o.load.netGrams, eff.filter((c) => inc.has(c.employeeId)).map((c) => ({ employeeId: c.employeeId, weight: c.matchedMs })));
    }
    next = {
      action: "override",
      method: manual ? "manual" : "proportional",
      shares: eff.map((c) => {
        const inc = given.find((s) => s.employeeId === c.employeeId)!.included;
        return { employeeId: c.employeeId, included: inc, matchedSeconds: Math.round(c.matchedMs / 1000), allocatedGrams: inc ? grams.get(c.employeeId) ?? 0 : 0 };
      }),
    };
  }

  await client.query(`delete from scale_productivity_allocations where weighing_id = $1`, [r.weighingId]);
  if (next) {
    await client.query(
      `insert into scale_productivity_allocations (weighing_id, activity_id, action, method, inputs_fingerprint, net_g, reason, decided_by_employee_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.weighingId, r.jobId, next.action, next.method, o.fingerprint, o.load.netGrams, r.reason, actor]
    );
    for (const s of next.shares) {
      await client.query(
        `insert into scale_productivity_allocation_shares (weighing_id, employee_id, included, matched_seconds, allocated_g) values ($1, $2, $3, $4, $5)`,
        [r.weighingId, s.employeeId, s.included, s.matchedSeconds, s.allocatedGrams]
      );
    }
  }
  await client.query(
    `insert into scale_productivity_allocation_history (request_id, weighing_id, activity_id, action, reason, previous, next, proposal, performed_by_employee_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      r.requestId,
      r.weighingId,
      r.jobId,
      r.action,
      r.reason,
      previous ? JSON.stringify({ action: previous.action, method: previous.method, reason: previous.reason, shares: previous.shares }) : null,
      next ? JSON.stringify(next) : null,
      JSON.stringify(proposal),
      actor,
    ]
  );
  return { ok: true, replay: false, version: version + 1 };
}

export const todayLocal = () => calendarDateInAppTimezone(new Date());
