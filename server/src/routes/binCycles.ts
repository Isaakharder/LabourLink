// Bin picking cycles (074, lib/binCycles.ts).
//
//   GET  /api/bin-cycles?state=open|recent&carrierId=   cycles, open ones first (Administrator, Manager)
//   GET  /api/bin-cycles/:id                            one cycle with its scans and history
//   POST /api/bin-cycles/:id/close                      close without weighing (Administrator)
//   POST /api/bin-cycles/:id/reinstate                  credit a superseded cycle instead (Administrator)
//   POST /api/bin-cycles/:id/confirm-superseded         confirm a superseded cycle (Administrator)
//   POST /api/bin-cycles/:id/resolve                    credit a needs-review cycle's weighing to one of its scanners (Administrator)
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { closeCycleWithoutWeighing, LATE_SUPERSEDED_REASON, OPEN_STATUSES, resolveCycle, reviewSupersededCycle } from "../lib/binCycles";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fullName = (alias: string) => `trim(${alias}.first_name || ' ' || coalesce(${alias}.last_name, ''))`;

function cycleJson(r: any) {
  return {
    id: r.id,
    bin: { id: r.carrier_id, name: r.bin_name },
    status: r.status,
    employee: { id: r.employee_id, name: r.employee_name },
    openedAt: r.opened_at,
    lastScanAt: r.last_scan_at,
    awaitingSince: r.awaiting_since,
    reviewReason: r.review_reason,
    scanCount: r.scan_count,
    weighing: r.weighing_id
      ? { id: r.weighing_id, weighedAt: r.weighed_at, netKg: Math.round(Number(r.net_g)) / 1000, status: r.weighing_status }
      : null,
    closedAt: r.closed_at,
    closeReason: r.close_reason,
    closedBy: r.closed_by_name || null,
    supersededByCycleId: r.superseded_by_cycle_id ?? null,
    reviewStatus: r.review_status ?? null,
    settled: r.status !== "superseded" || !!r.finalized_at,
    // A scan that reached LabourLink after the bin's weighing was already
    // credited to someone else (a late conflict), rather than a bin reused
    // before it was weighed.
    lateScan: r.status === "superseded" && r.close_reason === LATE_SUPERSEDED_REASON,
    resolution: r.resolved_at
      ? { employeeId: r.resolved_employee_id, employeeName: r.resolved_employee_name, resolvedBy: r.resolved_by_name, resolvedAt: r.resolved_at, reason: r.resolution_reason, previousStatus: r.resolution_previous_status }
      : null,
  };
}

const SELECT = `
  select bc.*, c.name as bin_name, ${fullName("e")} as employee_name, ${fullName("x")} as closed_by_name,
         ${fullName("re")} as resolved_employee_name, ${fullName("rb")} as resolved_by_name,
         w.weighed_at, w.net_g, w.status as weighing_status,
         (select count(*)::int from bin_scans s where s.cycle_id = bc.id) as scan_count
  from bin_cycles bc
  join carriers c on c.id = bc.carrier_id
  join employees e on e.id = bc.employee_id
  left join employees x on x.id = bc.closed_by_employee_id
  left join employees re on re.id = bc.resolved_employee_id
  left join employees rb on rb.id = bc.resolved_by_employee_id
  left join scale_weighings w on w.id = bc.weighing_id`;

router.get(
  "/",
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    // open: open cycles; recent: plus the last 2 days' closed ones; review:
    // superseded cycles waiting for an administrator's review.
    const state = req.query.state === "recent" ? "recent" : req.query.state === "review" ? "review" : "open";
    const carrierId = typeof req.query.carrierId === "string" && UUID_RE.test(req.query.carrierId) ? req.query.carrierId : null;
    const { rows: t } = await pool.query(
      `select (select started_at from bin_cycle_tracking where stopped_at is null) as running_since,
              exists (select 1 from bin_cycle_tracking) as ever_started`
    );
    const { rows } = await pool.query(
      `${SELECT}
       where ($1::uuid is null or bc.carrier_id = $1)
         and (case when $4 then bc.status = 'superseded' and bc.review_status = 'open'
                   else bc.status = any($2::text[]) or ($3 and bc.closed_at > now() - interval '2 days') end)
       order by (bc.status = any($2::text[])) desc, coalesce(bc.closed_at, bc.last_scan_at) desc
       limit 500`,
      [carrierId, OPEN_STATUSES, state === "recent", state === "review"]
    );
    // trackingStartedAt: the running period's start (null while stopped or never started).
    res.json({ trackingStartedAt: t[0].running_since ?? null, trackingEverStarted: t[0].ever_started, cycles: rows.map(cycleJson) });
  })
);

router.get(
  "/:id",
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid cycle id" });
    const { rows } = await pool.query(`${SELECT} where bc.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Picking cycle not found" });
    const [scans, events] = await Promise.all([
      pool.query(
        `select s.mobile_time_event_id, ${fullName("e")} as employee_name, s.occurred_at, s.received_at, d.device_name
         from bin_scans s join employees e on e.id = s.employee_id
         join mobile_time_events m on m.id = s.mobile_time_event_id left join devices d on d.id = m.device_id
         where s.cycle_id = $1 order by s.occurred_at`,
        [req.params.id]
      ),
      pool.query(
        `select ev.kind, ev.from_status, ev.to_status, ev.reason, ev.created_at, ${fullName("e")} as employee_name, ${fullName("a")} as actor_name
         from bin_cycle_events ev left join employees e on e.id = ev.employee_id left join employees a on a.id = ev.actor_employee_id
         where ev.cycle_id = $1 order by ev.created_at, ev.id`,
        [req.params.id]
      ),
    ]);
    res.json({
      cycle: {
        ...cycleJson(rows[0]),
        scans: scans.rows.map((s) => ({ employeeName: s.employee_name, occurredAt: s.occurred_at, receivedAt: s.received_at, deviceName: s.device_name })),
        history: events.rows.map((h) => ({
          kind: h.kind,
          fromStatus: h.from_status,
          toStatus: h.to_status,
          reason: h.reason,
          at: h.created_at,
          employeeName: h.employee_name || null,
          actorName: h.actor_name || null,
        })),
      },
    });
  })
);

router.post(
  "/:id/close",
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid cycle id" });
    const body = (req.body ?? {}) as { requestId?: unknown; reason?: unknown };
    const requestId = typeof body.requestId === "string" && UUID_RE.test(body.requestId) ? body.requestId : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!requestId) return res.status(400).json({ error: "requestId must be a UUID" });
    if (reason.length < 3) return res.status(400).json({ error: "A reason is required", errors: { reason: "Say why this cycle is closed without weighing" } });
    const r = await closeCycleWithoutWeighing(req.params.id, requestId, reason.slice(0, 500), req.employee!.id);
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code });
    const { rows } = await pool.query(`${SELECT} where bc.id = $1`, [req.params.id]);
    res.json({ cycle: cycleJson(rows[0]), replay: r.replay });
  })
);

for (const [path, action] of [["/:id/reinstate", "reinstate"], ["/:id/confirm-superseded", "confirm"]] as const) {
  router.post(
    path,
    requireRole("Administrator"),
    asyncHandler(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid cycle id" });
      const body = (req.body ?? {}) as { requestId?: unknown; reason?: unknown };
      const requestId = typeof body.requestId === "string" && UUID_RE.test(body.requestId) ? body.requestId : null;
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!requestId) return res.status(400).json({ error: "requestId must be a UUID" });
      if (reason.length < 3) return res.status(400).json({ error: "A reason is required", errors: { reason: "Say why" } });
      const r = await reviewSupersededCycle(req.params.id, requestId, action, reason.slice(0, 500), req.employee!.id);
      if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code });
      const { rows } = await pool.query(`${SELECT} where bc.id = $1`, [req.params.id]);
      res.json({ cycle: cycleJson(rows[0]), replay: r.replay, weighingId: r.weighingId ?? null });
    })
  );
}

router.post(
  "/:id/resolve",
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid cycle id" });
    const body = (req.body ?? {}) as { requestId?: unknown; employeeId?: unknown; reason?: unknown };
    const requestId = typeof body.requestId === "string" && UUID_RE.test(body.requestId) ? body.requestId : null;
    const employeeId = typeof body.employeeId === "string" && UUID_RE.test(body.employeeId) ? body.employeeId : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!requestId) return res.status(400).json({ error: "requestId must be a UUID" });
    if (!employeeId) return res.status(400).json({ error: "Choose the employee to credit", errors: { employeeId: "Choose the employee to credit" } });
    if (reason.length < 3) return res.status(400).json({ error: "A reason is required", errors: { reason: "Say why this employee gets the credit" } });
    const r = await resolveCycle(req.params.id, requestId, employeeId, reason.slice(0, 500), req.employee!.id);
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code });
    const { rows } = await pool.query(`${SELECT} where bc.id = $1`, [req.params.id]);
    res.json({ cycle: cycleJson(rows[0]), replay: r.replay });
  })
);

export default router;
