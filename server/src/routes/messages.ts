import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { sendPushForRecipients } from "../lib/pushDelivery";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

// No WHERE baked in — every call site appends its own, same convention as
// employeeBlocks.ts's blockSelect().
const MESSAGE_BASE_SELECT = `
  select em.id, em.message_text, em.created_by_employee_id, em.all_employees, em.created_at,
         ce.first_name as creator_first_name, ce.last_name as creator_last_name,
         count(emr.id) as recipient_count,
         count(emr.id) filter (where emr.acknowledged_at is not null) as acknowledged_count
  from employee_messages em
  join employees ce on ce.id = em.created_by_employee_id
  left join employee_message_recipients emr on emr.message_id = em.id
`;

function messageSelect(where?: string): string {
  return `${MESSAGE_BASE_SELECT} ${where ? `where ${where}` : ""} group by em.id, ce.first_name, ce.last_name`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeSummary(row: any) {
  const recipientCount = Number(row.recipient_count);
  const acknowledgedCount = Number(row.acknowledged_count);
  return {
    id: row.id,
    messageText: row.message_text,
    createdByEmployeeId: row.created_by_employee_id,
    createdByName: `${row.creator_first_name} ${row.creator_last_name}`,
    allEmployees: row.all_employees,
    createdAt: row.created_at,
    recipientCount,
    acknowledgedCount,
    status: recipientCount === 0 ? "sent" : acknowledgedCount >= recipientCount ? "acknowledged" : "pending",
  };
}

router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`${messageSelect()} order by em.created_at desc`);
    res.json({ messages: rows.map(serializeSummary) });
  })
);

router.get(
  "/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid message id" });

    const { rows } = await pool.query(messageSelect("em.id = $1"), [id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Message not found" });

    const recipients = await pool.query(
      `select emr.employee_id, e.first_name, e.last_name, e.is_active,
              emr.push_sent_at, emr.delivered_at, emr.acknowledged_at
       from employee_message_recipients emr
       join employees e on e.id = emr.employee_id
       where emr.message_id = $1
       order by e.first_name, e.last_name`,
      [id]
    );

    res.json({
      message: {
        ...serializeSummary(row),
        recipients: recipients.rows.map((r) => ({
          employeeId: r.employee_id,
          employeeName: `${r.first_name} ${r.last_name}`,
          employeeActive: r.is_active,
          pushSentAt: r.push_sent_at,
          deliveredAt: r.delivered_at,
          acknowledgedAt: r.acknowledged_at,
        })),
      },
    });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const messageText = trimOrNull(req.body?.messageText);
    if (!messageText) return res.status(400).json({ errors: { messageText: "Message text is required" } });

    const recipientMode = req.body?.recipientMode;
    if (recipientMode !== "all" && recipientMode !== "selected") {
      return res.status(400).json({ error: "recipientMode must be 'all' or 'selected'" });
    }

    let employeeIds: string[];
    if (recipientMode === "all") {
      // Snapshotted here, once, at send time — never re-derived later, so a
      // subsequent deactivation can't retroactively change who this send
      // says it went to (see 027_employee_messages.sql's header comment).
      const active = await pool.query("select id from employees where is_active = true");
      employeeIds = active.rows.map((r) => r.id);
    } else {
      const ids = req.body?.employeeIds;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((v) => typeof v === "string" && UUID_RE.test(v))) {
        return res.status(400).json({ error: "employeeIds must be a non-empty array of employee ids" });
      }
      // Re-validated against active employees server-side — a client-
      // supplied id list is never trusted as-is, same convention
      // employeeBlocks.ts's row-linking endpoint uses.
      const active = await pool.query(
        "select id from employees where id = any($1::uuid[]) and is_active = true",
        [ids]
      );
      if (active.rows.length !== new Set(ids).size) {
        return res.status(400).json({ error: "One or more selected employees are not active" });
      }
      employeeIds = active.rows.map((r) => r.id);
    }

    if (employeeIds.length === 0) {
      return res.status(400).json({ error: "No active employees to send to" });
    }

    const client = await pool.connect();
    let messageId: string;
    try {
      await client.query("begin");
      const insert = await client.query(
        `insert into employee_messages (message_text, created_by_employee_id, all_employees)
         values ($1, $2, $3) returning id`,
        [messageText, req.employee!.id, recipientMode === "all"]
      );
      messageId = insert.rows[0].id;
      await client.query(
        `insert into employee_message_recipients (message_id, employee_id)
         select $1, unnest($2::uuid[])`,
        [messageId, employeeIds]
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    // Best-effort push delivery, fire-and-forget — the recipient rows
    // (already committed above) are the source of truth regardless of
    // whether any push actually goes out; see pushDelivery.ts.
    sendPushForRecipients(messageId, employeeIds).catch((err) =>
      console.error("Push delivery failed for message", messageId, err)
    );

    const { rows: full } = await pool.query(messageSelect("em.id = $1"), [messageId]);
    res.status(201).json({ message: serializeSummary(full[0]) });
  })
);

export default router;
