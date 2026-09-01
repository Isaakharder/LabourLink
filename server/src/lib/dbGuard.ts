// Fails fast, before any connection is opened, if this process is about to
// talk to LabourLink's production database without explicit authorization.
//
// Root cause this exists for: on 2026-08-31, `npm run rollover:run` was run
// locally against server/.env's DATABASE_URL — which IS the production
// database, there being no separate dev/test instance at the time —
// retroactively rewriting real employees' time_entries (Marcelino Besa,
// Shaima Qasimi). `test:midnight-rollover`'s own test 4 calls the same
// table-wide runMidnightRolloverSweep() directly, so simply re-running the
// test suite could have repeated the incident. This module is the fix:
// recognize the one specific known production database by its connection
// identity, and refuse to proceed from any process that hasn't explicitly
// opted in.
//
// Wired into db.ts's module scope (the single place every consumer — the
// real server, every CLI script, every *.test.ts file — creates its Pool),
// so this can't be bypassed by importing anything else in this codebase.

// The Supabase project ref is embedded in both DATABASE_URL's pooler
// username (postgres.<ref>) and SUPABASE_URL (https://<ref>.supabase.co) —
// stable identity for this one specific database, not a guessable pattern
// that could ever match a legitimate future non-production instance.
const PRODUCTION_PROJECT_REF = "zuunsxojfwbgqxfpkgsw";

export function isProductionDatabaseUrl(connectionString: string): boolean {
  return connectionString.includes(PRODUCTION_PROJECT_REF);
}

export function assertDatabaseUrlAllowed(connectionString: string): void {
  if (!isProductionDatabaseUrl(connectionString)) return;
  if (process.env.ALLOW_PRODUCTION_DB === "true") return;

  throw new Error(
    "[dbGuard] Refusing to connect: DATABASE_URL identifies the production database, and " +
      "this process did not set ALLOW_PRODUCTION_DB=true.\n" +
      "  - Local development and tests must point DATABASE_URL at a separate database " +
      "(e.g. a local Postgres: `docker run -d -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16`, " +
      "then `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/<db> npm run migrate`).\n" +
      "  - Applying a migration to production intentionally requires the separate " +
      "`npm run migrate:production` command, not this one.\n" +
      "  - If this genuinely is the deployed production server or its scheduled cron job, " +
      "its environment must set ALLOW_PRODUCTION_DB=true explicitly."
  );
}
