import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice, requireDeviceRole } from "../middleware/device";
import { getSignedPhotoUrls } from "../lib/storage";
import { loadActiveRegistrations, sendPushForRecipients } from "../lib/pushDelivery";
import { resolveRecipients, createEmployeeMessage } from "../lib/employeeMessages";

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

// -----------------------------------------------------------------------
// Mobile Administrator messaging — the mobile app has no session cookie
// (device pairing is its only auth, see middleware/device.ts), so these
// routes exist as a mobile-authenticated entry point into the SAME
// underlying system routes/messages.ts (desktop) uses: same
// employee_messages/employee_message_recipients tables, same
// resolveRecipients/createEmployeeMessage (lib/employeeMessages.ts), same
// sendPushForRecipients (lib/pushDelivery.ts). Only the auth layer and the
// synchronous delivery summary differ from the desktop route — see each
// route's own comment.
//
// Both routes below are gated to exactly the same role as the desktop send
// action (requireRole("Administrator") on POST /api/messages) — Manager can
// view messages on desktop but not send, so Manager doesn't get the mobile
// send screen either. Enforced here regardless of what the mobile Settings
// UI shows/hides (display convenience only, see SettingsScreen.tsx).

// Candidate recipient list for the mobile compose screen — every active
// employee (the same "all employees" definition resolveRecipients uses),
// each with whether they currently have a reachable device. Not filtered to
// "currently clocked in" — sending a message isn't limited to who's on
// shift right now. One batched photo-URL call and one batched active-
// registration lookup, never per-employee.
router.get(
  "/messages/recipients",
  requireDeviceRole("Administrator"),
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `select id, first_name, last_name, profile_photo_path
       from employees where is_active = true order by first_name, last_name`
    );

    const photoPaths = [...new Set(rows.filter((r) => r.profile_photo_path).map((r) => r.profile_photo_path as string))];
    const photoUrlByPath = await getSignedPhotoUrls(photoPaths);

    const employeeIds = rows.map((r) => r.id as string);
    const registrations = await loadActiveRegistrations(employeeIds);
    const reachableIds = new Set(registrations.map((r) => r.employeeId));

    res.json({
      employees: rows.map((r) => ({
        id: r.id,
        firstName: r.first_name,
        lastName: r.last_name,
        photoUrl: r.profile_photo_path ? photoUrlByPath.get(r.profile_photo_path) ?? null : null,
        hasActiveDevice: reachableIds.has(r.id),
      })),
    });
  })
);

// Send from the mobile app. Unlike desktop's fire-and-forget POST
// /api/messages, this AWAITS sendPushForRecipients so it can return a real
// delivery summary in one response — the phone screen that just sent this
// has nowhere else to show that information (desktop admins can reopen GET
// /api/messages/:id afterward; the mobile compose screen doesn't have an
// equivalent "message detail" view to check back on). The DB recipient
// rows are still committed (via createEmployeeMessage) before push is even
// attempted, so a slow/failed push can never make this report "the message
// wasn't sent" when it actually was stored.
router.post(
  "/messages/send",
  requireDeviceRole("Administrator"),
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { messageText, recipientMode, employeeIds, idempotencyKey } = req.body as {
      messageText?: string;
      recipientMode?: "all" | "selected";
      employeeIds?: string[];
      idempotencyKey?: string;
    };

    const trimmed = typeof messageText === "string" ? messageText.trim() : "";
    if (!trimmed) return res.status(400).json({ error: "Message text is required" });
    if (recipientMode !== "all" && recipientMode !== "selected") {
      return res.status(400).json({ error: "recipientMode must be 'all' or 'selected'" });
    }
    if (!idempotencyKey || !UUID_RE.test(idempotencyKey)) {
      return res.status(400).json({ error: "a valid idempotencyKey is required" });
    }

    const resolved = await resolveRecipients(recipientMode, employeeIds);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    if (resolved.employeeIds.length === 0) {
      return res.status(400).json({ error: "No active employees to send to" });
    }

    const { messageId } = await createEmployeeMessage({
      messageText: trimmed,
      createdByEmployeeId: d.employeeId,
      recipientMode,
      employeeIds: resolved.employeeIds,
      idempotencyKey,
    });

    const push = await sendPushForRecipients(messageId, resolved.employeeIds);

    res.status(201).json({
      messageId,
      recipientCount: resolved.employeeIds.length,
      pushSucceeded: push.succeeded,
      pushFailed: push.failed,
      noActiveDeviceCount: push.noActiveDeviceEmployeeIds.length,
    });
  })
);

export default router;
