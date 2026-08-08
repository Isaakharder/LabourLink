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
// than trying to reconcile fields in place.
router.post(
  "/push/register",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { platform } = req.body as { platform?: string };

    let fcmToken: string | null = null;
    let webPushEndpoint: string | null = null;
    let webPushP256dh: string | null = null;
    let webPushAuth: string | null = null;

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
    } else {
      return res.status(400).json({ error: "platform must be 'android_fcm' or 'web_push'" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update device_push_registrations set disabled_at = now()
         where device_id = $1 and disabled_at is null`,
        [d.id]
      );
      await client.query(
        `insert into device_push_registrations
           (device_id, platform, fcm_token, web_push_endpoint, web_push_p256dh, web_push_auth)
         values ($1, $2, $3, $4, $5, $6)`,
        [d.id, platform, fcmToken, webPushEndpoint, webPushP256dh, webPushAuth]
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
