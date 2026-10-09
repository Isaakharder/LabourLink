// Regression coverage for parseCorsOrigins() and its actual enforcement via
// the real `cors` middleware — a parsed array that LOOKS right on its own
// isn't the same guarantee as the middleware actually using it correctly,
// so this exercises both: the pure parsing function directly (whitespace/
// trailing-comma/empty-entry handling), and a real Express server over real
// HTTP for the accept/reject behavior itself (added for the
// labourlink.lltech.io custom-domain CORS_ORIGIN change).
//
// Run with: npm run test:cors-origin
import cors from "cors";
import express from "express";
import { AddressInfo } from "net";
import { parseCorsOrigins } from "./corsOrigin";

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

function testParsing() {
  check(
    JSON.stringify(parseCorsOrigins("https://a.com,https://b.com")) === JSON.stringify(["https://a.com", "https://b.com"]),
    "plain comma-separated list, no whitespace"
  );
  check(
    JSON.stringify(parseCorsOrigins("https://a.com, https://b.com , https://c.com")) ===
      JSON.stringify(["https://a.com", "https://b.com", "https://c.com"]),
    "trims whitespace around every entry, including irregular spacing"
  );
  check(
    JSON.stringify(parseCorsOrigins("https://a.com,https://b.com,")) === JSON.stringify(["https://a.com", "https://b.com"]),
    "drops the empty entry from a trailing comma"
  );
  check(
    JSON.stringify(parseCorsOrigins("https://a.com,,https://b.com")) === JSON.stringify(["https://a.com", "https://b.com"]),
    "drops the empty entry from a double comma"
  );
  check(
    JSON.stringify(parseCorsOrigins(",https://a.com")) === JSON.stringify(["https://a.com"]),
    "drops the empty entry from a leading comma"
  );
  check(
    JSON.stringify(parseCorsOrigins("https://a.com,   ,https://b.com")) === JSON.stringify(["https://a.com", "https://b.com"]),
    "a whitespace-only entry (spaces between commas) is dropped, not kept as a blank origin"
  );
  check(
    JSON.stringify(parseCorsOrigins(undefined)) === JSON.stringify(["http://localhost:5173"]),
    "defaults to the local dev origin when CORS_ORIGIN is unset"
  );
  check(
    JSON.stringify(parseCorsOrigins("")) === JSON.stringify(["http://localhost:5173"]),
    "defaults to the local dev origin when CORS_ORIGIN is an empty string"
  );
  // The actual guarantee this whole function exists for: no matter how the
  // input is mangled with commas/whitespace, an empty string can never end
  // up as one of the accepted origins.
  const messy = parseCorsOrigins(" , https://a.com ,, ,https://b.com, ");
  check(
    messy.every((origin) => origin.length > 0),
    "no parsed origin is ever an empty string, regardless of how mangled the input is",
    messy
  );
  check(JSON.stringify(messy) === JSON.stringify(["https://a.com", "https://b.com"]), "and the real entries still come through correctly", messy);
}

// The exact production CORS_ORIGIN value being proposed for the
// labourlink.lltech.io custom domain — additive to the existing Railway web
// origin, Android's https://localhost, and iOS's capacitor://localhost, per
// server/.env.example.
const PROPOSED_PRODUCTION_CORS_ORIGIN =
  "https://web-production-1861a3.up.railway.app,https://labourlink.lltech.io,https://localhost,capacitor://localhost";

async function testEnforcement() {
  const origins = parseCorsOrigins(PROPOSED_PRODUCTION_CORS_ORIGIN);
  const app = express();
  app.use(cors({ origin: origins, credentials: true }));
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const custom = await fetch(`${base}/probe`, { headers: { Origin: "https://labourlink.lltech.io" } });
    check(
      custom.headers.get("access-control-allow-origin") === "https://labourlink.lltech.io",
      "the new custom web origin (labourlink.lltech.io) is accepted",
      custom.headers.get("access-control-allow-origin")
    );

    const existingWeb = await fetch(`${base}/probe`, {
      headers: { Origin: "https://web-production-1861a3.up.railway.app" },
    });
    check(
      existingWeb.headers.get("access-control-allow-origin") === "https://web-production-1861a3.up.railway.app",
      "the existing Railway web origin still works — confirms the value is additive, not a replacement"
    );

    const android = await fetch(`${base}/probe`, { headers: { Origin: "https://localhost" } });
    check(
      android.headers.get("access-control-allow-origin") === "https://localhost",
      "the Android WebView origin (https://localhost) still works"
    );

    const ios = await fetch(`${base}/probe`, { headers: { Origin: "capacitor://localhost" } });
    check(
      ios.headers.get("access-control-allow-origin") === "capacitor://localhost",
      "the iOS WebView origin (capacitor://localhost) still works"
    );

    const unknown = await fetch(`${base}/probe`, { headers: { Origin: "https://evil.example.com" } });
    check(
      unknown.headers.get("access-control-allow-origin") === null,
      "an unrelated, unknown origin is rejected — no Access-Control-Allow-Origin header at all",
      unknown.headers.get("access-control-allow-origin")
    );

    const noOrigin = await fetch(`${base}/probe`);
    check(noOrigin.status === 200, "a same-origin/no-Origin request (e.g. curl, a server-to-server call) still succeeds");
  } finally {
    server.close();
  }
}

async function main() {
  testParsing();
  await testEnforcement();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
