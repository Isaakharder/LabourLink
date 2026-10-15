#!/usr/bin/env node
// TEST ONLY. Drives the LOCAL LabourLink API (http://localhost:4000, the
// throwaway labourlink_kiosk_test database) for the emulator suite. Refuses
// any other host so it can never touch production.
//
//   node local-server.mjs approve-pairing [employeeId] [deviceName]
//                                                  approve the newest pending request
//   node local-server.mjs send-message "<text>"    message all active employees
const BASE = process.env.LL_LOCAL_API ?? "http://localhost:4000";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) {
  console.error("refusing: local-server.mjs only talks to a localhost API");
  process.exit(2);
}
const EMAIL = process.env.LL_ADMIN_EMAIL ?? "kiosk-admin@example.test";
const PIN = process.env.LL_ADMIN_PIN ?? "1234";

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, pin: PIN }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status}`);
  const me = await res.json();
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { cookie, me };
}

async function call(cookie, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${body}`);
  return body ? JSON.parse(body) : null;
}

const [cmd, arg, arg2] = process.argv.slice(2);
const { cookie, me } = await login();
const employeeId = (cmd === "approve-pairing" && arg) || me.employee?.id || me.id;

if (cmd === "approve-pairing") {
  const { requests } = await call(cookie, "/api/devices/pairing-requests");
  const req = requests[0];
  if (!req) throw new Error("no pending pairing request");
  await call(cookie, `/api/devices/pairing-requests/${req.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ deviceName: arg2 ?? "Kiosk emulator", employeeId }),
  });
  console.log(`approved ${req.pairing_code ?? req.pairingCode ?? req.id}`);
} else if (cmd === "send-message") {
  const r = await call(cookie, "/api/messages", {
    method: "POST",
    body: JSON.stringify({ messageText: arg ?? "Kiosk test message", recipientMode: "all" }),
  });
  console.log(JSON.stringify(r));
} else {
  console.error("unknown command");
  process.exit(2);
}
