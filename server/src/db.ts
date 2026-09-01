import { Pool } from "pg";
import { assertDatabaseUrlAllowed } from "./lib/dbGuard";

const rawConnectionString = process.env.DATABASE_URL;

if (!rawConnectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Fails fast, before any connection is opened, if this process has no
// business talking to the production database — see dbGuard.ts. Every
// consumer of `pool` (the real server, every CLI script, every test file)
// goes through this one module, so this is the single choke point.
assertDatabaseUrlAllowed(rawConnectionString);

// A bare loopback host is always a local/throwaway Postgres (Docker for
// tests, a developer's own instance) — never Supabase or any other real
// hosted database, which are only ever reached over a network hostname.
// Local Postgres run via `docker run postgres` doesn't speak SSL at all, so
// forcing sslmode=require against it fails outright ("the server does not
// support SSL connections") — this is the one case where skipping the
// encryption-in-transit requirement below is correct rather than a
// regression, precisely because the traffic never leaves the machine.
const isLocalHost = (() => {
  try {
    const host = new URL(rawConnectionString).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
})();

// Enforce sslmode=require on the connection string itself, regardless of
// whether the DATABASE_URL env var happens to include it — so this can't
// silently regress if the value is ever edited without it. uselibpqcompat
// is required alongside it: current pg-connection-string otherwise treats
// "require" as an alias for "verify-full" (full CA-chain validation), which
// fails against Supabase's pooler cert in every environment. libpq-compat
// mode restores the standard meaning of "require" — encrypt, don't verify —
// which is what rejectUnauthorized: false below is also asking for.
const connectionString = (() => {
  if (isLocalHost) return rawConnectionString;
  const url = new URL(rawConnectionString);
  if (!url.searchParams.has("sslmode")) {
    url.searchParams.set("sslmode", "require");
  }
  if (!url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
})();

export const pool = new Pool({
  connectionString,
  // Pinned explicitly (matches pg's own default of 10) rather than left
  // implicit — Supabase's session-mode pooler on this project hard-caps
  // at 15 total client connections ("EMAXCONNSESSION" when exceeded,
  // confirmed by raising this to 20 during testing), so there's very
  // little headroom above the default to give to any single endpoint's
  // Promise.all concurrency (reportQueries.ts/carrierCompletionAttribution.ts's
  // per-candidate-run resolution, mobileEmployees.ts's per-activity
  // attribution calls) without risking exhausting the pool for every other
  // concurrent request the app is serving at the same time.
  max: 10,
  // Supabase's pooled connection presents a certificate Node won't validate
  // against a local CA bundle. This is needed unconditionally for a real
  // (non-local) host: with sslmode=require on the connection string above
  // and no explicit ssl override, pg-connection-string treats "require" as
  // an alias for "verify-full" and attempts full chain validation, which
  // fails with "self-signed certificate in certificate chain" against
  // Supabase's pooler in any environment (confirmed locally). Encryption is
  // still mandatory everywhere via sslmode=require; this only skips
  // CA-chain validation. Explicitly `undefined` (not omitted) for a local
  // host — the `pg` client negotiates SSL whenever this key is present at
  // all, even without rejectUnauthorized, which a bare local Postgres
  // doesn't speak.
  ssl: isLocalHost ? undefined : { rejectUnauthorized: false },
  // Without these, a stalled TCP handshake (e.g. packets silently dropped by
  // a network restriction) hangs the request indefinitely instead of failing
  // fast — that's what turned into a 2-minute hang -> Railway 502 in prod.
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 30000,
});

// Without this listener, an error on an already-connected but idle pooled
// client (e.g. the network drops it while it's just sitting in the pool) is
// an unhandled 'error' event on the Pool's EventEmitter — which crashes the
// whole process the same way an unhandled promise rejection does.
pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});
