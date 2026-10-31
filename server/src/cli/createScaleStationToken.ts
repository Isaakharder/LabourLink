// Creates the bearer token for a weighing station (scale_stations,
// 070_scale_weighings.sql). Only the token's sha256 hash is ever stored; the
// token itself is printed once and cannot be retrieved again. If it is lost,
// deactivate the station (`is_active = false`) and create a new one.
//
// The production database is not reachable from a developer machine, so by
// default this only prints the token and the SQL to run in the Supabase SQL
// Editor. `--insert` writes the row into the DATABASE_URL database instead
// (local or demo; dbGuard.ts refuses production).
//
// The new station always starts with credits_enabled = false (trial).
//
// Usage:
//   npm run scale:station-token -- "Weigh station 1"
//   npm run scale:station-token -- "Weigh station 1" --insert
import { generateIntegrationToken } from "../lib/integrationToken";

async function run() {
  const args = process.argv.slice(2);
  const insert = args.includes("--insert");
  const name = args.filter((a) => a !== "--insert")[0]?.trim();
  if (!name) {
    console.error('Usage: npm run scale:station-token -- "Station name" [--insert]');
    process.exit(1);
  }

  const { token, tokenHash } = generateIntegrationToken();

  if (insert) {
    await import("dotenv/config");
    const { pool } = await import("../db");
    const { rows } = await pool.query(
      `insert into scale_stations (name, token_hash) values ($1, $2) returning id, name, credits_enabled`,
      [name, tokenHash]
    );
    console.log("Created scale station:", rows[0]);
    await pool.end();
  } else {
    const quoted = name.replace(/'/g, "''");
    console.log("Run this in the Supabase SQL Editor (it stores only the token's hash):");
    console.log("");
    console.log(`  insert into scale_stations (name, token_hash) values ('${quoted}', '${tokenHash}') returning id, name, credits_enabled;`);
  }

  console.log("");
  console.log("Station token (copy it now; it cannot be retrieved again):");
  console.log(`  ${token}`);
  console.log("");
  console.log("On the station, store it root-only (see scale/README.md, \"Going live\"):");
  console.log("  sudo install -m 0600 /dev/stdin /etc/labourlink-scale/station-token");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
