// Migration test for 072_scale_weighing_corrections.sql: additive
// (scale_weighings unchanged), a credit can be voided once, a correction
// request id is applied once, a reason is required, and the two views count
// exactly what the Scale Weighings page and any future report rely on.
// Runs in ONE transaction that is always rolled back; drops 072's objects
// inside it first, so it is repeatable on a DB that already has 072.
//
// Run with: npm run test:migration-072-scale-weighing-corrections
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
const SQL = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "072_scale_weighing_corrections.sql"), "utf8");

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
  const weighings = `select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as h from scale_weighings t`;
  try {
    await client.query("begin");
    await client.query(`drop view if exists scale_production_weighings, scale_employee_credits; drop table if exists scale_weighing_corrections;`);
    const before = (await client.query(weighings)).rows[0].h;
    await client.query(SQL);
    check((await client.query(weighings)).rows[0].h === before, "A) scale_weighings is unchanged");

    const roleId = (await client.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const teamRoleId = (await client.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const emp = (
      await client.query(`insert into employees (first_name, last_name, security_role_id, team_role_id) values ('QA', $1, $2, $3) returning id`, [`Mig072 ${RUN_ID}`, roleId, teamRoleId])
    ).rows[0].id;
    const carrier = (await client.query(`insert into carriers (name) values ($1) returning id`, [`QA Mig072 ${RUN_ID}`])).rows[0].id;
    const station = (await client.query(`insert into scale_stations (name, token_hash) values ($1, $2) returning id`, [`QA Mig072 ${RUN_ID}`, `h072-${RUN_ID}`])).rows[0].id;
    const w = async (status: string, employee: string | null, live: boolean, dup = false) =>
      (
        await client.query(
          `insert into scale_weighings (station_id, station_weighing_id, carrier_id, rfid_tag, gross_g, tare_g, net_g, weighed_at, pending_until, credits_live, status, employee_id, is_duplicate)
           values ($1, $2, $3, 'T1', 2000, 1000, 1000, now(), now(), $4, $5, $6, $7) returning id`,
          [station, randomUUID(), carrier, live, status, employee, dup]
        )
      ).rows[0].id as string;
    const credited = await w("credited", emp, true);
    const trial = await w("credited", emp, false);
    const voided = await w("voided", emp, true);
    const dup = await w("needs_review", null, true, true);
    const pending = await w("pending", null, true);

    const inView = async (view: string) =>
      new Set((await client.query(`select id from ${view} where station_id = $1`, [station])).rows.map((r) => r.id as string));
    const production = await inView("scale_production_weighings");
    check(
      production.has(credited) && production.has(trial) && production.has(pending) && !production.has(voided) && !production.has(dup),
      "B) production totals: everything except voided and duplicates"
    );
    const credits = await inView("scale_employee_credits");
    check(credits.size === 1 && credits.has(credited), "B) employee credits: live credits only (no trial, voided, pending)");

    const insert = (weighingId: string, correctionId: string, reason = "Wrong picker") =>
      violation(
        client,
        `insert into scale_weighing_corrections (correction_id, weighing_id, action, reason, previous_status, previous_employee_id, performed_by_employee_id)
         values ($1, $2, 'void', $3, 'credited', $4, $4)`,
        [correctionId, weighingId, reason, emp]
      );
    const c1 = randomUUID();
    check((await insert(voided, c1)) === null, "C) a void is recorded");
    check((await insert(voided, randomUUID())) === "scale_weighing_corrections_one_void", "C) a credit can be voided once");
    check((await insert(credited, c1)) === "scale_weighing_corrections_request_key", "C) a correction request is applied once");
    check((await insert(credited, randomUUID(), "  ")) === "scale_weighing_corrections_reason_check", "C) a reason is required");
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
