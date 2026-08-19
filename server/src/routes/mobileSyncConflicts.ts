// Desktop admin surface for mobile_time_events rows the sync ledger
// (mobileTime.ts's POST /sync/events) recorded as 'permanent_conflict' or
// 'sequence_gap' — the structured review-queue requirement from the
// offline-first plan: these are never auto-resolved and never silently
// dropped, so an administrator needs somewhere to actually see them.
// "Resolving" one here only marks it reviewed (resolved_at/resolved_by/
// resolution_note) — it never itself mutates time_entries. Whatever real
// correction is needed (fixing an employee's actual worked time) happens
// through the existing Inputs manual-correction flow, same as any other
// data problem; this page is where an admin finds out a correction is
// needed and records that they've dealt with it.
import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeConflict(row: any) {
  return {
    id: row.id,
    clientEventId: row.client_event_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    employeeId: row.employee_id,
    employeeName: row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : null,
    deviceSeq: Number(row.device_seq),
    eventType: row.event_type,
    occurredAtUtc: row.occurred_at_utc,
    receivedAt: row.received_at,
    processingStatus: row.processing_status,
    conflictReason: row.conflict_reason,
    conflictDetail: row.conflict_detail,
    payload: row.payload,
    resolvedAt: row.resolved_at,
    resolvedBy:
      row.resolved_by_first_name && row.resolved_by_last_name
        ? `${row.resolved_by_first_name} ${row.resolved_by_last_name}`
        : null,
    resolutionNote: row.resolution_note,
  };
}

const CONFLICT_SELECT = `
  select mte.*, d.device_name, e.first_name, e.last_name,
         rb.first_name as resolved_by_first_name, rb.last_name as resolved_by_last_name
  from mobile_time_events mte
  left join devices d on d.id = mte.device_id
  left join employees e on e.id = mte.employee_id
  left join employees rb on rb.id = mte.resolved_by
`;

// A row is "reviewable" either because the server outright couldn't apply
// it (permanent_conflict/sequence_gap) or because it DID apply but carries
// a device-clock-anomaly flag (mobileTime.ts's detectClockAnomaly) — an
// 'accepted' row with a non-null conflict_reason. Shared by the list query
// and both mutation routes below so "what counts as reviewable" can't drift
// between them.
const REVIEWABLE_CONDITION = `(
  mte.processing_status in ('permanent_conflict', 'sequence_gap')
  or (mte.processing_status = 'accepted' and mte.conflict_reason is not null)
)`;

// GET /api/mobile-sync/conflicts?includeResolved=true
// Unresolved reviewable rows by default (the review queue) —
// includeResolved=true additionally shows already-reviewed ones, for
// looking back at what was previously handled.
router.get(
  "/conflicts",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const includeResolved = req.query.includeResolved === "true";
    const where = includeResolved ? REVIEWABLE_CONDITION : `${REVIEWABLE_CONDITION} and mte.resolved_at is null`;
    const { rows } = await pool.query(`${CONFLICT_SELECT} where ${where} order by mte.received_at desc`);
    res.json({ conflicts: rows.map(serializeConflict) });
  })
);

// POST /api/mobile-sync/conflicts/:id/resolve — marks reviewed, optionally
// with a free-text note about what was actually done about it. Never
// touches time_entries; a real correction (if one was needed) already
// happened separately through Inputs before an admin marks this reviewed.
router.post(
  "/conflicts/:id/resolve",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid conflict id" });
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : null;

    const { rows } = await pool.query(
      `update mobile_time_events mte
       set resolved_at = now(), resolved_by = $2, resolution_note = $3
       where mte.id = $1 and ${REVIEWABLE_CONDITION}
       returning mte.id`,
      [id, req.employee!.id, note || null]
    );
    if (!rows[0]) return res.status(404).json({ error: "Conflict not found" });

    const { rows: fullRows } = await pool.query(`${CONFLICT_SELECT} where mte.id = $1`, [id]);
    res.json({ conflict: serializeConflict(fullRows[0]) });
  })
);

// POST /api/mobile-sync/conflicts/:id/unresolve — undo an accidental
// "Mark Reviewed" click. Simple state clear, no history kept beyond this
// (the row's own updated resolved_at/resolved_by/resolution_note already
// IS the only record of the previous resolution, which this intentionally
// discards — same as any other "undo" action in this app).
router.post(
  "/conflicts/:id/unresolve",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid conflict id" });

    const { rows } = await pool.query(
      `update mobile_time_events
       set resolved_at = null, resolved_by = null, resolution_note = null
       where id = $1
       returning id`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Conflict not found" });

    const { rows: fullRows } = await pool.query(`${CONFLICT_SELECT} where mte.id = $1`, [id]);
    res.json({ conflict: serializeConflict(fullRows[0]) });
  })
);

export default router;
