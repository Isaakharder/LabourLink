import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice } from "../middleware/device";

const router = Router();
router.use(asyncHandler(requireDevice));

// Registers (or refreshes) this device's push destination. At most one
// active registration per device (partial unique index,
// 028_device_push_registrations.sql) — re-registering (a token refresh, or
// switching between the Android app and a PWA install on the same
// identifier) disables whatever was active and inserts a fresh row, rather
// than trying to reconcile fields in place. Re-posting the SAME destination
// is a no-op (just touches updated_at).
router.post(
  "/push/register",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { platform } = req.body as { platform?: string };

    let fcmToken: string | null = null;
    let webPushEndpoint: string | null = null;
    let webPushP256dh: string | null = null;
    let webPushAuth: string | null = null;
    let apnsToken: string | null = null;

    if (platform === "android_fcm") {
      const { fcmToken: token } = req.body as { fcmToken?: string };
      if (!token || typeof token !== "string") {
        return res.status(400).json({ error: "fcmToken is required for platform android_fcm" });
      }
      fcmToken = token;
    } else if (platform === "web_push") {
      const { subscription } = req.body as {
        subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      };
      if (
        !subscription?.endpoint ||
        typeof subscription.endpoint !== "string" ||
        !subscription.keys?.p256dh ||
        !subscription.keys?.auth
      ) {
        return res.status(400).json({ error: "A valid Web Push subscription is required for platform web_push" });
      }
      webPushEndpoint = subscription.endpoint;
      webPushP256dh = subscription.keys.p256dh;
      webPushAuth = subscription.keys.auth;
    } else if (platform === "ios_apns") {
      // The raw APNs device token as hex (currently 64 chars; Apple says not
      // to rely on the length). Delivered by lib/apns.ts.
      const { apnsToken: token } = req.body as { apnsToken?: string };
      if (!token || typeof token !== "string" || !/^[0-9a-f]{32,200}$/i.test(token)) {
        return res.status(400).json({ error: "A hex apnsToken is required for platform ios_apns" });
      }
      apnsToken = token.toLowerCase();
    } else {
      return res.status(400).json({ error: "platform must be 'android_fcm', 'web_push' or 'ios_apns'" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      // Serialize concurrent registrations for this one device (a launch
      // and a resume landing together) so the check below can't race.
      await client.query(`select id from devices where id = $1 for update`, [d.id]);

      // The app now re-posts its token on launch/resume whenever it can't
      // confirm the server already has it, so an unchanged token must be a
      // no-op rather than churning a fresh row each time.
      const existing = await client.query(
        `select id from device_push_registrations
         where device_id = $1 and disabled_at is null and platform = $2
           and fcm_token is not distinct from $3 and web_push_endpoint is not distinct from $4
           and web_push_p256dh is not distinct from $5 and web_push_auth is not distinct from $6
           and apns_token is not distinct from $7`,
        [d.id, platform, fcmToken, webPushEndpoint, webPushP256dh, webPushAuth, apnsToken]
      );

      if (existing.rows[0]) {
        await client.query(`update device_push_registrations set updated_at = now() where id = $1`, [existing.rows[0].id]);
      } else {
        await client.query(
          `update device_push_registrations set disabled_at = now()
           where device_id = $1 and disabled_at is null`,
          [d.id]
        );
        await client.query(
          `insert into device_push_registrations
             (device_id, platform, fcm_token, web_push_endpoint, web_push_p256dh, web_push_auth, apns_token)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [d.id, platform, fcmToken, webPushEndpoint, webPushP256dh, webPushAuth, apnsToken]
        );
      }

      // A push token identifies one app install. If the same token is still
      // active on a DIFFERENT device row (the phone was re-paired under a new
      // identifier, or reassigned), that older row is stale: leaving it
      // active would notify whoever that old row is assigned to on this
      // phone. Only the device that just proved it holds the token keeps it.
      await client.query(
        `update device_push_registrations set disabled_at = now()
         where device_id <> $1 and disabled_at is null
           and ((fcm_token is not null and fcm_token = $2)
             or (web_push_endpoint is not null and web_push_endpoint = $3)
             or (apns_token is not null and apns_token = $4))`,
        [d.id, fcmToken, webPushEndpoint, apnsToken]
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.status(204).send();
  })
);

// Whether the server currently holds an active push registration for THIS
// device row. The app checks this before trusting its local "already
// registered this token" cache, so a registration the server disabled (an
// FCM rejection) or one that belongs to an older device row (re-pair under a
// new identifier) is re-registered on the next launch/resume instead of
// being skipped forever. Never returns the token itself.
router.get(
  "/push/status",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { rows } = await pool.query(
      `select platform, updated_at from device_push_registrations
       where device_id = $1 and disabled_at is null`,
      [d.id]
    );
    res.json({ registered: !!rows[0], platform: rows[0]?.platform ?? null, updatedAt: rows[0]?.updated_at ?? null });
  })
);

// Disables this device's active push registration — e.g. the employee
// turns notifications off, or local permission is revoked. Never deletes
// history; matches the same "disable, don't delete" convention a stale/
// invalid token uses on a failed send (see pushDelivery.ts).
router.post(
  "/push/unregister",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    await pool.query(
      `update device_push_registrations set disabled_at = now()
       where device_id = $1 and disabled_at is null`,
      [d.id]
    );
    res.status(204).send();
  })
);

export default router;
