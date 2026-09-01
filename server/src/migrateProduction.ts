// Explicit, separate entry point for applying migrations to the production
// database. Deliberately not the same command as `npm run migrate` (which
// now refuses outright against production via dbGuard.ts) — migrating the
// live database is exactly the kind of hard-to-reverse action that should
// never be one ordinary `npm run migrate` away from a routine local run.
//
// Usage: CONFIRM_PRODUCTION_MIGRATION=yes-apply-to-production npm run migrate:production
import "dotenv/config";

async function main() {
  if (process.env.CONFIRM_PRODUCTION_MIGRATION !== "yes-apply-to-production") {
    console.error(
      'Refusing to run: set CONFIRM_PRODUCTION_MIGRATION="yes-apply-to-production" to confirm you ' +
        "intend to apply migrations to the LIVE production database."
    );
    process.exit(1);
    return;
  }
  // Set before importing ./migrate (dynamically, so this assignment runs
  // first — a static top-level `import` would be hoisted above this check
  // and load db.ts, and therefore dbGuard's throw, before either env var
  // was set) so db.ts's guard recognizes this run as authorized.
  process.env.ALLOW_PRODUCTION_DB = "true";
  await import("./migrate");
}

main();
