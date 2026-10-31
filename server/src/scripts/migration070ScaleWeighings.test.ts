// Migration test for 070_scale_weighings.sql: proves the migration is purely
// additive (carriers, employees, mobile_time_events and time_entries are
// byte-for-byte unchanged) and that its constraints enforce what the station
// API and matcher rely on: net = gross - tare, an employee only on a credit,
// a duplicate never credited, one row per station weighing id, and one phone
// event crediting at most one weighing.
//
// Runs inside ONE transaction that is always rolled back. Repeatable on a DB
// that already has 070: the new objects are dropped inside the transaction
// first, then the real migration file is run.
//
// Run with: npm run test:migration-070-scale-weighings
import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
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
const MIGRATION_SQL = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "070_scale_weighings.sql"), "utf8");

async function fingerprint(client: PoolClient) {
  const { rows } = await client.query(`
    select
      (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from carriers t) as carriers,
      (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from employees t) as employees,
      (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from mobile_time_events t) as mobile_time_events,
      (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from time_entries t) as time_entries
  `);
  return rows[0];
}

// Runs a statement under a savepoint; returns the constraint it violated.
async function violation(client: PoolClient, sql: string, params: unknown[]): Promise<string | null> {
  await client.query("savepoint s");
  try {
    await client.query(sql, params);
    await client.query("release savepoint s");
    return null;
  } catch (err) {
    await client.query("rollback to savepoint s");
    const e = err as { constraint?: string; code?: string };
    return e.constraint ?? e.code ?? "error";
  }
}

async function main() {
  if (isProductionDatabaseUrl(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against production");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`
      drop index if exists idx_mobile_time_events_scale_claims;
      -- cascade: on a database that also has 071/072, their objects depend
      -- on these tables. Everything is rolled back at the end.
      drop table if exists scale_weighing_events, scale_weighing_flags, scale_weighing_claims, scale_weighings, scale_stations cascade;
    `);
    const before = await fingerprint(client);
    await client.query(MIGRATION_SQL);
    const after = await fingerprint(client);
    check(JSON.stringify(before) === JSON.stringify(after), "A) existing tables are unchanged", { before, after });

    // Fixtures (rolled back with everything else).
    const roleId = (await client.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const teamRoleId = (await client.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const emp = (
      await client.query(
        `insert into employees (first_name, last_name, security_role_id, team_role_id) values ('QA', $1, $2, $3) returning id`,
        [`Mig070 ${RUN_ID}`, roleId, teamRoleId]
      )
    ).rows[0].id;
    const carrier = (await client.query(`insert into carriers (name) values ($1) returning id`, [`QA Mig070 ${RUN_ID}`])).rows[0].id;
    const station = (
      await client.query(`insert into scale_stations (name, token_hash) values ($1, $2) returning id, credits_enabled`, [
        `QA Mig070 ${RUN_ID}`,
        `hash-${RUN_ID}`,
      ])
    ).rows[0];
    check(station.credits_enabled === false, "B) a station starts with credits off");
    check(
      (await violation(client, `insert into scale_stations (name, token_hash) values ($1, $2)`, [`other ${RUN_ID}`, `hash-${RUN_ID}`])) ===
        "scale_stations_token_hash_key",
      "B) a token hash belongs to one station"
    );

    const insert = (o: Record<string, unknown> = {}) => {
      const v = {
        station_weighing_id: randomUUID(),
        gross_g: 172500,
        tare_g: 154400,
        net_g: 18100,
        status: "pending",
        employee_id: null,
        is_duplicate: false,
        ...o,
      };
      return violation(
        client,
        `insert into scale_weighings (station_id, station_weighing_id, carrier_id, rfid_tag, gross_g, tare_g, net_g, weighed_at,
           pending_until, credits_live, status, employee_id, is_duplicate)
         values ($1, $2, $3, '0000000182225750', $4, $5, $6, now(), now() + interval '24 hours', false, $7, $8, $9)`,
        [station.id, v.station_weighing_id, carrier, v.gross_g, v.tare_g, v.net_g, v.status, v.employee_id, v.is_duplicate]
      );
    };
    check((await insert()) === null, "C) a valid pending weighing inserts");
    check((await insert({ net_g: 18000 })) === "chk_scale_weighings_weights", "C) net must equal gross - tare");
    check((await insert({ tare_g: 0, net_g: 172500 })) === "chk_scale_weighings_weights", "C) tare must be above zero");
    check((await insert({ status: "credited" })) === "chk_scale_weighings_employee", "C) a credit needs an employee");
    check((await insert({ employee_id: emp })) === "chk_scale_weighings_employee", "C) only a credit has an employee");
    check((await insert({ status: "credited", employee_id: emp })) === null, "C) a credit with an employee inserts");
    check((await insert({ status: "voided", employee_id: emp })) === null, "C) a voided credit keeps its employee");
    check(
      (await insert({ status: "credited", employee_id: emp, is_duplicate: true })) === "chk_scale_weighings_duplicate_not_credited",
      "C) a duplicate can never be credited"
    );
    check((await insert({ status: "approved" })) === "chk_scale_weighings_status", "C) unknown statuses are refused");
    const sameId = randomUUID();
    await insert({ station_weighing_id: sameId });
    check((await insert({ station_weighing_id: sameId })) === "scale_weighings_station_weighing_key", "C) one row per station weighing id");

    // One phone event can credit only one weighing.
    const device = (
      await client.query(`insert into devices (device_identifier, device_name) values ($1, 'QA Mig070') returning id`, [randomUUID()])
    ).rows[0].id;
    const event = (
      await client.query(
        `insert into mobile_time_events (client_event_id, device_id, employee_id, device_seq, event_type, occurred_at_utc,
           local_tz_offset_minutes, payload, processing_status)
         values ($1, $2, $3, 1, 'activity_switch', now(), 0, '{}', 'accepted') returning id`,
        [randomUUID(), device, emp]
      )
    ).rows[0].id;
    const ws = (await client.query(`select id from scale_weighings where station_id = $1 limit 2`, [station.id])).rows;
    check(
      (await violation(client, `insert into scale_weighing_claims (mobile_time_event_id, weighing_id, employee_id) values ($1, $2, $3)`, [
        event,
        ws[0].id,
        emp,
      ])) === null,
      "D) a phone event can credit a weighing"
    );
    check(
      (await violation(client, `insert into scale_weighing_claims (mobile_time_event_id, weighing_id, employee_id) values ($1, $2, $3)`, [
        event,
        ws[1].id,
        emp,
      ])) === "scale_weighing_claims_pkey",
      "D) ...but never a second one"
    );
  } finally {
    await client.query("rollback");
    client.release();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
