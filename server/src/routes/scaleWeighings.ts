// Scale Weighings page: every weighing the weighing stations recorded, one
// day at a time, with administrator voiding of an incorrect credit.
//
//   GET  /api/scale-weighings?date=&carrierId=&employeeId=&status=   one day's weighings and totals
//   GET  /api/scale-weighings/:id                                    one weighing with its full history
//   POST /api/scale-weighings/:id/void                               void a credit (Administrator)
//
// Totals come from the views in 072_scale_weighing_corrections.sql, the one
// definition of what counts: production totals leave out voided and
// duplicate weighings; credited kilograms count only live (non-trial),
// non-voided credits.
//
// Single-tenant schema (see 043_mobile_time_events.sql): there is no
// organization column to scope by; access is the same session + role check
// as Reports.
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { recordWeighingEvent } from "../lib/scaleMatching";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["pending", "credited", "needs_review", "expired", "voided"];

const kg = (g: number | string) => Math.round(Number(g)) / 1000;
const fullName = (alias: string) => `trim(${alias}.first_name || ' ' || coalesce(${alias}.last_name, ''))`;

router.get(
  "/",
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const date = typeof req.query.date === "string" && DATE_RE.test(req.query.date) ? req.query.date : calendarDateInAppTimezone(new Date());
    const { start, end } = getDayBoundsUtc(date);
    const carrierId = typeof req.query.carrierId === "string" && UUID_RE.test(req.query.carrierId) ? req.query.carrierId : null;
    const employeeId = typeof req.query.employeeId === "string" && UUID_RE.test(req.query.employeeId) ? req.query.employeeId : null;
    const status = typeof req.query.status === "string" ? req.query.status : "all";
    if (status !== "all" && status !== "not_credited" && !STATUSES.includes(status)) {
      return res.status(400).json({ error: "Unknown status filter" });
    }

    const { rows } = await pool.query(
      `select w.id, w.weighed_at, w.carrier_id, c.name as bin_name, w.rfid_tag, w.gross_g, w.tare_g, w.net_g,
              w.employee_id, ${fullName("e")} as employee_name, w.status, w.credits_live, w.is_duplicate,
              w.match_reason, w.pending_until, s.name as station_name,
              (select count(*)::int from scale_weighing_flags f where f.weighing_id = w.id) as flag_count,
              exists (select 1 from scale_production_weighings p where p.id = w.id) as counts_for_production,
              exists (select 1 from scale_employee_credits k where k.id = w.id) as counts_as_credit
       from scale_weighings w
       join carriers c on c.id = w.carrier_id
       join scale_stations s on s.id = w.station_id
       left join employees e on e.id = w.employee_id
       where w.weighed_at >= $1 and w.weighed_at < $2
       order by w.weighed_at desc, w.id`,
      [start, end]
    );

    // Filter choices come from the whole day, so picking one filter never
    // hides the others' options.
    const bins = new Map<string, string>();
    const employees = new Map<string, string>();
    for (const r of rows) {
      bins.set(r.carrier_id, r.bin_name);
      if (r.employee_id) employees.set(r.employee_id, r.employee_name);
    }

    const shown = rows.filter(
      (r) =>
        (!carrierId || r.carrier_id === carrierId) &&
        (!employeeId || r.employee_id === employeeId) &&
        (status === "all" ||
          (status === "not_credited" ? ["pending", "needs_review", "expired"].includes(r.status) : r.status === status))
    );

    const production = shown.filter((r) => r.counts_for_production);
    const credits = shown.filter((r) => r.counts_as_credit);
    res.json({
      date,
      totals: {
        netKg: kg(production.reduce((sum, r) => sum + r.net_g, 0)),
        binsWeighed: production.length,
        creditedNetKg: kg(credits.reduce((sum, r) => sum + r.net_g, 0)),
        credited: credits.length,
        pending: shown.filter((r) => r.status === "pending").length,
        needsReview: shown.filter((r) => r.status === "needs_review" && !r.is_duplicate).length,
        neverCredited: shown.filter((r) => (r.status === "needs_review" || r.status === "expired") && !r.is_duplicate).length,
        duplicates: shown.filter((r) => r.is_duplicate).length,
        voided: shown.filter((r) => r.status === "voided").length,
        trial: shown.filter((r) => !r.credits_live).length,
      },
      weighings: shown.map((r) => ({
        id: r.id,
        weighedAt: r.weighed_at,
        bin: { id: r.carrier_id, name: r.bin_name },
        rfidTag: r.rfid_tag,
        grossKg: kg(r.gross_g),
        tareKg: kg(r.tare_g),
        netKg: kg(r.net_g),
        employee: r.employee_id ? { id: r.employee_id, name: r.employee_name } : null,
        status: r.status,
        creditsLive: r.credits_live,
        isDuplicate: r.is_duplicate,
        countsForProduction: r.counts_for_production,
        matchReason: r.match_reason,
        pendingUntil: r.status === "pending" ? r.pending_until : null,
        stationName: r.station_name,
        flagCount: r.flag_count,
      })),
      filters: {
        bins: [...bins].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
        employees: [...employees].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      },
    });
  })
);

async function loadDetail(id: string) {
  const { rows } = await pool.query(
    `select w.*, c.name as bin_name, s.name as station_name, ${fullName("e")} as employee_name,
            exists (select 1 from scale_production_weighings p where p.id = w.id) as counts_for_production,
            exists (select 1 from scale_employee_credits k where k.id = w.id) as counts_as_credit
     from scale_weighings w
     join carriers c on c.id = w.carrier_id
     join scale_stations s on s.id = w.station_id
     left join employees e on e.id = w.employee_id
     where w.id = $1`,
    [id]
  );
  const w = rows[0];
  if (!w) return null;
  const [history, claims, flags, corrections] = await Promise.all([
    pool.query(
      `select ev.kind, ev.from_status, ev.to_status, ev.reason, ev.created_at,
              ${fullName("e")} as employee_name, ${fullName("a")} as actor_name
       from scale_weighing_events ev
       left join employees e on e.id = ev.employee_id
       left join employees a on a.id = ev.actor_employee_id
       where ev.weighing_id = $1 order by ev.created_at, ev.id`,
      [id]
    ),
    pool.query(
      `select ${fullName("e")} as employee_name, m.occurred_at_utc, m.received_at, m.event_type, d.device_name
       from scale_weighing_claims cl
       join mobile_time_events m on m.id = cl.mobile_time_event_id
       join employees e on e.id = cl.employee_id
       left join devices d on d.id = m.device_id
       where cl.weighing_id = $1 order by m.occurred_at_utc`,
      [id]
    ),
    pool.query(
      `select f.kind, ${fullName("e")} as employee_name, m.occurred_at_utc, m.received_at
       from scale_weighing_flags f
       join mobile_time_events m on m.id = f.mobile_time_event_id
       join employees e on e.id = f.employee_id
       where f.weighing_id = $1 order by m.occurred_at_utc`,
      [id]
    ),
    pool.query(
      `select co.action, co.reason, co.previous_status, co.performed_at,
              ${fullName("p")} as previous_employee_name, ${fullName("b")} as performed_by
       from scale_weighing_corrections co
       left join employees p on p.id = co.previous_employee_id
       join employees b on b.id = co.performed_by_employee_id
       where co.weighing_id = $1 order by co.performed_at`,
      [id]
    ),
  ]);
  return {
    id: w.id,
    stationWeighingId: w.station_weighing_id,
    weighedAt: w.weighed_at,
    receivedAt: w.received_at,
    bin: { id: w.carrier_id, name: w.bin_name },
    rfidTag: w.rfid_tag,
    grossKg: kg(w.gross_g),
    tareKg: kg(w.tare_g),
    netKg: kg(w.net_g),
    samplesKg: (w.samples_g as number[]).map(kg),
    employee: w.employee_id ? { id: w.employee_id, name: w.employee_name } : null,
    status: w.status,
    creditsLive: w.credits_live,
    isDuplicate: w.is_duplicate,
    countsForProduction: w.counts_for_production,
    countsAsCredit: w.counts_as_credit,
    matchReason: w.match_reason,
    pendingUntil: w.status === "pending" ? w.pending_until : null,
    resolvedAt: w.resolved_at,
    stationName: w.station_name,
    history: history.rows.map((h) => ({
      kind: h.kind,
      fromStatus: h.from_status,
      toStatus: h.to_status,
      reason: h.reason,
      at: h.created_at,
      employeeName: h.employee_name || null,
      actorName: h.actor_name || null,
    })),
    claims: claims.rows.map((c) => ({
      employeeName: c.employee_name,
      occurredAt: c.occurred_at_utc,
      receivedAt: c.received_at,
      eventType: c.event_type,
      deviceName: c.device_name,
    })),
    flags: flags.rows.map((f) => ({ kind: f.kind, employeeName: f.employee_name, occurredAt: f.occurred_at_utc, receivedAt: f.received_at })),
    corrections: corrections.rows.map((c) => ({
      action: c.action,
      reason: c.reason,
      previousStatus: c.previous_status,
      previousEmployeeName: c.previous_employee_name || null,
      performedAt: c.performed_at,
      performedBy: c.performed_by,
    })),
  };
}

router.get(
  "/:id",
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid weighing id" });
    const detail = await loadDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "Weighing not found" });
    res.json({ weighing: detail });
  })
);

// Voids an incorrect credit. The weighing, its weights, its original
// employee and the phone claims that credited it all stay; the status
// becomes 'voided', which every total leaves out (see the views in 072).
// Idempotent on correctionId; a credit can be voided once.
router.post(
  "/:id/void",
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid weighing id" });
    const body = (req.body ?? {}) as { correctionId?: unknown; reason?: unknown };
    const correctionId = typeof body.correctionId === "string" && UUID_RE.test(body.correctionId) ? body.correctionId : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!correctionId) return res.status(400).json({ error: "correctionId must be a UUID" });
    if (reason.length < 3) return res.status(400).json({ error: "A reason is required", errors: { reason: "Say why this credit is being voided" } });

    const client = await pool.connect();
    try {
      await client.query("begin");
      // Row lock first, so a repeated request waits for the original and is
      // then answered as a replay.
      const { rows } = await client.query(`select id, status, employee_id from scale_weighings where id = $1 for update`, [id]);
      const w = rows[0];
      if (!w) {
        await client.query("rollback");
        return res.status(404).json({ error: "Weighing not found" });
      }
      const { rows: done } = await client.query(`select weighing_id from scale_weighing_corrections where correction_id = $1`, [correctionId]);
      if (done[0]) {
        await client.query("rollback");
        if (done[0].weighing_id !== id) return res.status(409).json({ error: "This correction was already used for another weighing" });
        return res.json({ weighing: await loadDetail(id), replay: true });
      }
      if (w.status !== "credited") {
        await client.query("rollback");
        return res.status(409).json({
          error: w.status === "voided" ? "This credit has already been voided" : "Only a credited weighing can be voided",
          code: w.status === "voided" ? "alreadyVoided" : "notCredited",
        });
      }
      await client.query(`update scale_weighings set status = 'voided', resolved_at = now() where id = $1`, [id]);
      await client.query(
        `insert into scale_weighing_corrections
           (correction_id, weighing_id, action, reason, previous_status, previous_employee_id, performed_by_employee_id)
         values ($1, $2, 'void', $3, $4, $5, $6)`,
        [correctionId, id, reason, w.status, w.employee_id, req.employee!.id]
      );
      await recordWeighingEvent(client, {
        weighingId: id,
        kind: "void",
        fromStatus: w.status,
        toStatus: "voided",
        employeeId: w.employee_id,
        actorEmployeeId: req.employee!.id,
        reason,
      });
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      // A concurrent request with the same correctionId (or a second void
      // racing this one) loses on the unique index: answer with the result.
      if ((err as { code?: string }).code === "23505") {
        const detail = await loadDetail(id);
        return detail?.status === "voided"
          ? res.json({ weighing: detail, replay: true })
          : res.status(409).json({ error: "Another correction was saving at the same moment. Reload and try again." });
      }
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json({ weighing: await loadDetail(id) });
  })
);

export default router;
