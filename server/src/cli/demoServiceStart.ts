// Start command for the app-store DEMO API service ONLY (`npm run start:demo`,
// see migrations/058_reviewer_pairing.sql). On every start it:
//   1. refuses unless LABOURLINK_DEMO_INSTANCE=true, and refuses the
//      production database outright (even with ALLOW_PRODUCTION_DB);
//   2. refuses a database that already holds employees but is not marked as
//      a demo instance — checked BEFORE migrating, so a demo service wired to
//      the wrong database changes nothing;
//   3. applies migrations, seeds fictional data (once), and registers the
//      reviewer code whose SHA-256 is in REVIEWER_CODE_SHA256 — the code
//      itself is never stored in Railway or the database;
//   4. starts the normal API.
//
// Rotating the env-registered code: set REVIEWER_CODE_SHA256 to a new hash
// and redeploy — the previous env-registered code is revoked (devices it
// paired keep working). Unset it to revoke without a replacement. Revoking
// AND deactivating devices: `npm run reviewer:credentials -- revoke <id>`.
import "dotenv/config";
import { execFileSync } from "child_process";
import path from "path";
import { Client } from "pg";
import { isDemoInstanceEnabled } from "../lib/demoInstance";
import { isProductionDatabaseUrl } from "../lib/dbGuard";

export const ENV_CREDENTIAL_LABEL = "Registered from REVIEWER_CODE_SHA256";

function fail(message: string): never {
  console.error(`[demo-start] ${message}`);
  process.exit(1);
}

function connectionOptions(raw: string) {
  const local = ["localhost", "127.0.0.1", "::1"].includes(new URL(raw).hostname);
  return { connectionString: raw, ssl: local ? undefined : { rejectUnauthorized: false } };
}

async function preflight(raw: string) {
  const c = new Client(connectionOptions(raw));
  await c.connect();
  try {
    const { rows } = await c.query(
      `select to_regclass('public.employees') is not null as has_employees_table,
              to_regclass('public.demo_instance') is not null as has_marker_table`
    );
    if (!rows[0].has_employees_table) return; // brand-new database
    const employees = await c.query(`select count(*)::int as n from employees`);
    if (employees.rows[0].n === 0) return;
    const marked = rows[0].has_marker_table && (await c.query(`select 1 from demo_instance where id = true`)).rows.length > 0;
    if (!marked) {
      fail(`This database has ${employees.rows[0].n} employee(s) and is not a demo instance — refusing to migrate, seed or start.`);
    }
  } finally {
    await c.end();
  }
}

async function registerEnvCredential(raw: string) {
  const hash = process.env.REVIEWER_CODE_SHA256?.trim().toLowerCase() || "";
  if (hash && !/^[0-9a-f]{64}$/.test(hash)) fail("REVIEWER_CODE_SHA256 must be a 64-character hex SHA-256.");
  const c = new Client(connectionOptions(raw));
  await c.connect();
  try {
    await c.query("begin");
    const rotated = await c.query(
      `update reviewer_pairing_credentials set revoked_at = now()
       where label = $1 and revoked_at is null and code_hash <> $2 returning id`,
      [ENV_CREDENTIAL_LABEL, hash]
    );
    if (rotated.rowCount) console.log(`[demo-start] revoked ${rotated.rowCount} previous env-registered code(s); their devices keep working`);
    if (hash) {
      // Never re-activates a code that was revoked (e.g. through the CLI).
      const inserted = await c.query(
        `insert into reviewer_pairing_credentials (label, code_hash, code_hint)
         values ($1, $2, 'env') on conflict (code_hash) do nothing returning id`,
        [ENV_CREDENTIAL_LABEL, hash]
      );
      console.log(
        inserted.rowCount
          ? `[demo-start] registered reviewer code from REVIEWER_CODE_SHA256 (id ${inserted.rows[0].id})`
          : "[demo-start] reviewer code from REVIEWER_CODE_SHA256 already registered"
      );
    }
    await c.query("commit");
  } catch (err) {
    await c.query("rollback");
    throw err;
  } finally {
    await c.end();
  }
}

async function main() {
  if (!isDemoInstanceEnabled()) fail("LABOURLINK_DEMO_INSTANCE=true is required — this start command is only for the demo service.");
  const raw = process.env.DATABASE_URL;
  if (!raw) fail("DATABASE_URL is not set.");
  if (isProductionDatabaseUrl(raw)) fail("DATABASE_URL is the production database — the demo service must use its own database.");

  await preflight(raw);

  // Compiled siblings in dist/ (this file runs as dist/cli/demoServiceStart.js).
  const dist = path.join(__dirname, "..");
  const run = (file: string) => execFileSync(process.execPath, [path.join(dist, file)], { stdio: "inherit", env: process.env });
  run("migrate.js");
  run(path.join("cli", "seedDemoInstance.js"));
  await registerEnvCredential(raw);

  require(path.join(dist, "index.js"));
}

main().catch((err) => {
  console.error("[demo-start] failed:", err);
  process.exit(1);
});
