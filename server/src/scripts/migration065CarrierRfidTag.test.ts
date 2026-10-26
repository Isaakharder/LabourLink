// Migration test for 065_carrier_rfid_tag.sql: proves the migration is
// purely additive (every existing carrier, NFC mapping and time entry is
// byte-for-byte unchanged and every carrier's rfid_tag starts null) and that
// the new constraints do what the Carriers API relies on (text with leading
// zeros preserved, normalized format, one carrier per tag, inactive carriers
// included, any number of unassigned carriers).
//
// Everything runs inside ONE transaction that is always rolled back, so the
// database is left exactly as found. That also makes it repeatable on a DB
// that has already applied 065: the test drops the column inside the
// transaction first, recreating the pre-065 shape, then runs the real
// migration file against it.
//
// Run with: npm run test:migration-065-carrier-rfid-tag
import "dotenv/config";
import fs from "fs";
import path from "path";
import { PoolClient } from "pg";
import { pool } from "../db";
import { isProductionDatabaseUrl } from "../lib/dbGuard";

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

const RUN_ID = Date.now();
const MIGRATION_SQL = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "065_carrier_rfid_tag.sql"), "utf8");

// md5 over every row (all pre-065 columns) of each table the migration must
// not change, ordered by primary key so the fingerprint is deterministic.
async function fingerprint(client: PoolClient) {
  const { rows } = await client.query(`
    select
      (select md5(coalesce(string_agg(t::text, '|' order by t.id), ''))
         from (select id, name, notes, tare_weight_kg, is_active, created_at, updated_at from carriers) t) as carriers,
      (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from nfc_tag_mappings t) as nfc_tag_mappings,
      (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from time_entries t) as time_entries,
      (select count(*)::int from carriers) as carrier_count
  `);
  return rows[0];
}

// Runs a statement under a savepoint so an expected constraint violation
// doesn't abort the surrounding transaction. Returns the pg error, if any.
async function attempt(client: PoolClient, sql: string, params: unknown[]): Promise<{ code?: string; constraint?: string } | null> {
  await client.query("savepoint attempt");
  try {
    await client.query(sql, params);
    await client.query("release savepoint attempt");
    return null;
  } catch (err) {
    await client.query("rollback to savepoint attempt");
    return err as { code?: string; constraint?: string };
  }
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (isProductionDatabaseUrl(url)) {
    // DDL test: never against production, even with ALLOW_PRODUCTION_DB.
    throw new Error("Refusing to run the 065 migration test against the production database");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const { rows: existing } = await client.query(
      `select 1 from information_schema.columns where table_name = 'carriers' and column_name = 'rfid_tag'`
    );
    if (existing.length > 0) {
      await client.query(`drop index if exists carriers_rfid_tag_key`);
      await client.query(`alter table carriers drop column rfid_tag`);
    }

    // Pre-065 fixtures shaped like the real 86 bins: tare weights, an
    // inactive one, and a carrier with an active NFC (Ridder) mapping.
    const { rows: role } = await client.query(`select id from security_roles where name = 'Administrator'`);
    const { rows: team } = await client.query(`select id from team_roles order by id limit 1`);
    const { rows: emp } = await client.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
       values ('QA', $1, $2, $3, $4, 'x', true) returning id`,
      [`Migration065 ${RUN_ID}`, `qa-migration065-${RUN_ID}@test.local`, role[0].id, team[0].id]
    );
    const { rows: seeded } = await client.query(
      `insert into carriers (name, tare_weight_kg, is_active) values
         ($1, 27.50, true), ($2, 12.25, true), ($3, 0, false)
       returning id`,
      [`QA065 Bin 1 ${RUN_ID}`, `QA065 Bin 2 ${RUN_ID}`, `QA065 Bin 3 ${RUN_ID}`]
    );
    await client.query(
      `insert into nfc_tag_mappings (carrier_id, tag_kind, ridder_hardware_id, created_by_employee_id)
       values ($1, 'ridder', $2, $3)`,
      [seeded[0].id, `QA065${RUN_ID}`, emp[0].id]
    );

    const before = await fingerprint(client);

    // The real migration file, exactly as migrate.ts would apply it.
    await client.query(MIGRATION_SQL);

    const after = await fingerprint(client);
    check(after.carriers === before.carriers, "A) every existing carrier's id/name/notes/tare/status/timestamps unchanged", { before, after });
    check(after.nfc_tag_mappings === before.nfc_tag_mappings, "B) NFC tag mappings unchanged", { before, after });
    check(after.time_entries === before.time_entries, "C) time entries (picking history) unchanged", { before, after });
    check(after.carrier_count === before.carrier_count, "D) no carrier rows added or removed", { before, after });

    const { rows: nonNull } = await client.query(`select count(*)::int as n from carriers where rfid_tag is not null`);
    check(nonNull[0].n === 0, "E) every existing carrier starts with rfid_tag null (Not assigned)", nonNull[0]);

    const { rows: col } = await client.query(
      `select data_type, is_nullable from information_schema.columns where table_name = 'carriers' and column_name = 'rfid_tag'`
    );
    check(col[0]?.data_type === "text" && col[0]?.is_nullable === "YES", "F) rfid_tag is nullable text", col[0]);

    // Leading zeros survive a round-trip.
    await client.query(`update carriers set rfid_tag = '0000000182225750' where id = $1`, [seeded[0].id]);
    const { rows: stored } = await client.query(`select rfid_tag from carriers where id = $1`, [seeded[0].id]);
    check(stored[0].rfid_tag === "0000000182225750", "G) a 16-digit tag keeps its leading zeros", stored[0]);

    // One carrier per tag — including an inactive carrier.
    const dup = await attempt(client, `update carriers set rfid_tag = '0000000182225750' where id = $1`, [seeded[2].id]);
    check(dup?.code === "23505" && dup?.constraint === "carriers_rfid_tag_key", "H) a second (inactive) carrier cannot take the same tag", dup);

    // Many carriers may be unassigned at once (partial index ignores null).
    const { rows: nulls } = await client.query(
      `select count(*)::int as n from carriers where id = any($1::uuid[]) and rfid_tag is null`,
      [[seeded[1].id, seeded[2].id]]
    );
    check(nulls[0].n === 2, "I) multiple carriers can be unassigned simultaneously", nulls[0]);

    // Non-normalized values are rejected by the DB itself.
    for (const bad of ["", "0000 0001", "abc123", "R-0000"]) {
      const err = await attempt(client, `update carriers set rfid_tag = $1 where id = $2`, [bad, seeded[1].id]);
      check(err?.code === "23514" && err?.constraint === "chk_carriers_rfid_tag_format", `J) format check rejects ${JSON.stringify(bad)}`, err);
    }
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }

  // Rolled back: none of the fixtures exist afterwards.
  const { rows: leftover } = await pool.query(`select count(*)::int as n from carriers where name like $1`, [`QA065 %${RUN_ID}`]);
  check(leftover[0].n === 0, "K) transaction rolled back, no fixtures left behind", leftover[0]);
  await pool.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
