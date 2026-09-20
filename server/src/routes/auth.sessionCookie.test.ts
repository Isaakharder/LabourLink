// getSessionCookieOptions is pure — no DB, no HTTP server needed. Locks in
// the exact flags the Safari cross-site-cookie investigation depends on:
// httpOnly always, and secure/sameSite flipping together in production
// (sameSite: "none" is invalid without secure: true — browsers reject it
// outright), while staying "lax"/insecure for local http:// dev.
//
// Run with: npm run test:auth-session-cookie
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-auth-session-cookie-test";
// routes/auth.ts imports ../db (for the /login handler), which requires
// DATABASE_URL just to construct its Pool at module load — never actually
// queried by anything this file exercises. A loopback URL satisfies
// dbGuard.ts's production-safety check without needing a real database.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/labourlink_test";

import { getSessionCookieOptions } from "./auth";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

function main() {
  const prod = getSessionCookieOptions(true);
  check(prod.httpOnly === true, "production: httpOnly", prod);
  check(prod.secure === true, "production: secure (required for sameSite: none)", prod);
  check(prod.sameSite === "none", "production: sameSite none (cross-site Railway subdomains)", prod);

  const dev = getSessionCookieOptions(false);
  check(dev.httpOnly === true, "dev: httpOnly", dev);
  check(dev.secure === false, "dev: not secure (plain http:// locally)", dev);
  check(dev.sameSite === "lax", "dev: sameSite lax", dev);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
