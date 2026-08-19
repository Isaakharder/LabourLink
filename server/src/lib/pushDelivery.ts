import webpush from "web-push";
import { cert, initializeApp, App } from "firebase-admin/app";
import { getMessaging, Messaging } from "firebase-admin/messaging";
import { pool } from "../db";

// Self-generated ECDSA keypair (not a third-party credential) — see
// server/.env.example for the generation command. Configured once at
// module load; every environment missing these simply gets no Web Push
// delivery (the mandatory in-app outstanding-message fetch still works
// regardless — push is a delivery alert only, never the source of truth).
let vapidConfigured = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  vapidConfigured = true;
} else {
  console.warn("[push] VAPID keys not configured — Web Push delivery is disabled");
}

// Lazily initialized only if a real Firebase project's credentials are
// present — requires FIREBASE_SERVICE_ACCOUNT_JSON (see server/.env.example
// for exactly where to get it). Never crashes the server when absent; just
// skips Android push sends and warns once.
let firebaseApp: App | null = null;
let firebaseWarned = false;
function getFirebaseMessaging(): Messaging | null {
  if (firebaseApp) return getMessaging(firebaseApp);
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    if (!firebaseWarned) {
      console.warn("[push] FIREBASE_SERVICE_ACCOUNT_JSON not configured — Android push delivery is disabled");
      firebaseWarned = true;
    }
    return null;
  }
  firebaseApp = initializeApp({ credential: cert(JSON.parse(raw)) });
  return getMessaging(firebaseApp);
}

export interface PushRegistration {
  employeeId: string;
  registrationId: string;
  platform: "android_fcm" | "web_push";
  fcmToken: string | null;
  webPushEndpoint: string | null;
  webPushP256dh: string | null;
  webPushAuth: string | null;
}

// Exported for callers that need to know reachability BEFORE (or instead
// of) actually sending — e.g. the mobile Messages recipient picker
// (mobileMessages.ts's GET /messages/recipients) shows whether each
// candidate currently has a reachable device. There is at most one active
// registration per employee (one active device_assignment per employee,
// 033_one_active_device_per_employee.sql, times at most one active
// registration per device, the partial unique index in
// 028_device_push_registrations.sql), so employeeId is effectively unique
// in the returned rows.
export async function loadActiveRegistrations(employeeIds: string[]): Promise<PushRegistration[]> {
  const { rows } = await pool.query(
    `select da.employee_id, dpr.id as registration_id, dpr.platform,
            dpr.fcm_token, dpr.web_push_endpoint, dpr.web_push_p256dh, dpr.web_push_auth
     from device_assignments da
     join devices d on d.id = da.device_id and d.is_active = true
     join device_push_registrations dpr on dpr.device_id = d.id and dpr.disabled_at is null
     where da.unassigned_at is null and da.employee_id = any($1::uuid[])`,
    [employeeIds]
  );
  return rows.map((r) => ({
    employeeId: r.employee_id,
    registrationId: r.registration_id,
    platform: r.platform,
    fcmToken: r.fcm_token,
    webPushEndpoint: r.web_push_endpoint,
    webPushP256dh: r.web_push_p256dh,
    webPushAuth: r.web_push_auth,
  }));
}

// Deliberately generic — never the actual message text. Push is only a
// delivery alert; the real content always comes from the authenticated
// GET /api/mobile/messages/outstanding fetch that follows (see
// server/src/routes/mobileMessages.ts).
const PUSH_TITLE = "LabourLink";
const PUSH_BODY = "You have a new message. Open LabourLink to read it.";

async function markPushSent(messageId: string, employeeId: string): Promise<void> {
  await pool.query(
    `update employee_message_recipients set push_sent_at = coalesce(push_sent_at, now())
     where message_id = $1 and employee_id = $2`,
    [messageId, employeeId]
  );
}

async function disableRegistration(registrationId: string): Promise<void> {
  await pool.query(`update device_push_registrations set disabled_at = now() where id = $1`, [registrationId]);
}

// attempted/succeeded/failed count REGISTRATIONS, not employees (an
// employee with zero active registrations contributes to none of the
// three — see noActiveDeviceEmployeeIds below for that case). Returned so
// callers that need a synchronous delivery summary can build one (the
// mobile Messages send screen, mobileMessages.ts's POST /messages/send);
// desktop's fire-and-forget caller (routes/messages.ts) simply ignores the
// return value, unchanged from before this was added.
export interface PushDeliverySummary {
  attempted: number;
  succeeded: number;
  failed: number;
  // Employees among the input list who had no active registration at all
  // (no assigned device, an inactive device, or a device that's never
  // registered/has since disabled push) — distinct from a registration that
  // was attempted and failed.
  noActiveDeviceEmployeeIds: string[];
}

// Best-effort fan-out to every currently-registered device for the given
// employees — called fire-and-forget from POST /api/messages (see
// routes/messages.ts); a failure here must never fail or delay the send
// itself, since the DB recipient rows (already committed before this runs)
// are the actual source of truth. A permanently-invalid token/subscription
// (FCM "unregistered", Web Push 404/410) disables that registration so
// future sends stop retrying against it; any other failure just logs and
// leaves the registration alone for the next message to try again.
export async function sendPushForRecipients(messageId: string, employeeIds: string[]): Promise<PushDeliverySummary> {
  if (employeeIds.length === 0) return { attempted: 0, succeeded: 0, failed: 0, noActiveDeviceEmployeeIds: [] };
  const registrations = await loadActiveRegistrations(employeeIds);
  const reachableEmployeeIds = new Set(registrations.map((r) => r.employeeId));
  const noActiveDeviceEmployeeIds = employeeIds.filter((id) => !reachableEmployeeIds.has(id));

  let succeeded = 0;
  let failed = 0;

  await Promise.all(
    registrations.map(async (reg) => {
      try {
        if (reg.platform === "android_fcm") {
          const messaging = getFirebaseMessaging();
          if (!messaging || !reg.fcmToken) {
            failed++; // push not configured on this server — no notification will arrive
            return;
          }
          await messaging.send({
            token: reg.fcmToken,
            notification: { title: PUSH_TITLE, body: PUSH_BODY },
            data: { type: "message" },
          });
        } else {
          if (!vapidConfigured || !reg.webPushEndpoint || !reg.webPushP256dh || !reg.webPushAuth) {
            failed++; // push not configured on this server — no notification will arrive
            return;
          }
          await webpush.sendNotification(
            { endpoint: reg.webPushEndpoint, keys: { p256dh: reg.webPushP256dh, auth: reg.webPushAuth } },
            JSON.stringify({ title: PUSH_TITLE, body: PUSH_BODY, type: "message" })
          );
        }
        await markPushSent(messageId, reg.employeeId);
        succeeded++;
      } catch (err) {
        failed++;
        const statusCode = (err as { statusCode?: number }).statusCode;
        const code = (err as { code?: string }).code;
        const permanentlyInvalid =
          statusCode === 404 ||
          statusCode === 410 ||
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token" ||
          code === "messaging/invalid-argument";
        if (permanentlyInvalid) {
          await disableRegistration(reg.registrationId).catch(() => {});
        } else {
          console.error(`[push] delivery failed for registration=${reg.registrationId}:`, err);
        }
      }
    })
  );

  return { attempted: registrations.length, succeeded, failed, noActiveDeviceEmployeeIds };
}
