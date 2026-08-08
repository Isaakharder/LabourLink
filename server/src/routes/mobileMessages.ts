import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice } from "../middleware/device";

const router = Router();
router.use(asyncHandler(requireDevice));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every unacknowledged message for the paired employee, oldest first — the
// mobile app's one mandatory check (app start, resume, after pairing; see
// web/src/context/MessagesContext.tsx). Marks delivered_at the first time
// each row is actually returned here — the one server-verifiable "the
// phone has this" signal, deliberately distinct from push having been sent
// (see 027_employee_messages.sql's header comment).
router.get(
  "/messages/outstanding",
  asyncHandler(async (req, res) => {
    const d = req.device!;

    await pool.query(
      `update employee_message_recipients
       set delivered_at = now()
       where employee_id = $1 and acknowledged_at is null and delivered_at is null`,
      [d.employeeId]
    );

    const { rows } = await pool.query(
      `select emr.id as recipient_id, em.id as message_id, em.message_text, em.created_at,
              ce.first_name as sender_first_name, ce.last_name as sender_last_name
       from employee_message_recipients emr
       join employee_messages em on em.id = emr.message_id
       join employees ce on ce.id = em.created_by_employee_id
       where emr.employee_id = $1 and emr.acknowledged_at is null
       order by em.created_at asc`,
      [d.employeeId]
    );

    res.json({
      messages: rows.map((r) => ({
        recipientId: r.recipient_id,
        messageId: r.message_id,
        messageText: r.message_text,
        createdAt: r.created_at,
        senderName: `${r.sender_first_name} ${r.sender_last_name}`,
      })),
    });
  })
);

// Idempotent: acknowledging an already-acknowledged recipient row (a
// retried tap, or a replayed request) succeeds without changing anything,
// never errors. Scoped strictly to the requesting device's own
// req.device.employeeId — never a client-supplied id — so an employee can
// only ever acknowledge their own messages; a recipientId belonging to a
// different employee simply 404s.
router.post(
  "/messages/:recipientId/acknowledge",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { recipientId } = req.params;
    if (!UUID_RE.test(recipientId)) return res.status(400).json({ error: "Invalid recipient id" });

    const { rows } = await pool.query(
      `update employee_message_recipients
       set acknowledged_at = coalesce(acknowledged_at, now()),
           delivered_at = coalesce(delivered_at, now())
       where id = $1 and employee_id = $2
       returning acknowledged_at`,
      [recipientId, d.employeeId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Message not found for this device" });

    res.json({ acknowledgedAt: rows[0].acknowledged_at });
  })
);

export default router;
