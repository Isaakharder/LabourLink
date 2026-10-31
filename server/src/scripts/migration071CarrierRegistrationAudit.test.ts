// Migration test for 071_carrier_registration_audit.sql: purely additive
// (carriers unchanged), and one registration request can write at most one
// row per bin. Runs in ONE transaction that is always rolled back; drops the
// table inside it first, so it is repeatable on a DB that already has 071.
//
// Run with: npm run test:migration-071-carrier-registration-audit
import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
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
const SQL = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "071_carrier_registration_audit.sql"), "utf8");

async function main() {
  if (isProductionDatabaseUrl(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against production");
  const client = await pool.connect();
  const carriers = `select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as h from carriers t`;
  try {
    await client.query("begin");
    await client.query(`drop table if exists carrier_registration_audit`);
    const before = (await client.query(carriers)).rows[0].h;
    await client.query(SQL);
    check((await client.query(carriers)).rows[0].h === before, "A) carriers are unchanged");

    const roleId = (await client.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
    const teamRoleId = (await client.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const emp = (
      await client.query(`insert into employees (first_name, last_name, security_role_id, team_role_id) values ('QA', $1, $2, $3) returning id`, [
        `Mig071 ${RUN_ID}`,
        roleId,
        teamRoleId,
      ])
    ).rows[0].id;
    const c1 = (await client.query(`insert into carriers (name) values ($1) returning id`, [`QA Mig071 A ${RUN_ID}`])).rows[0].id;
    const c2 = (await client.query(`insert into carriers (name) values ($1) returning id`, [`QA Mig071 B ${RUN_ID}`])).rows[0].id;
    const reg = randomUUID();
    const insert = async (carrier: string, registrationId: string | null, action = "register", source = "scale_station") => {
      await client.query("savepoint s");
      try {
        await client.query(
          `insert into carrier_registration_audit (registration_id, carrier_id, source, action, performed_by_employee_id) values ($1, $2, $3, $4, $5)`,
          [registrationId, carrier, source, action, emp]
        );
        await client.query("release savepoint s");
        return null;
      } catch (err) {
        await client.query("rollback to savepoint s");
        return (err as { constraint?: string }).constraint ?? "error";
      }
    };
    check((await insert(c1, reg)) === null, "B) a registration row inserts");
    check((await insert(c2, reg, "move_tag")) === null, "B) the same request may also record the bin a tag moved from");
    check((await insert(c1, reg)) === "carrier_registration_audit_once", "B) but never twice for one bin");
    check((await insert(c1, null, "page_edit", "carriers_page")) === null && (await insert(c1, null, "page_edit", "carriers_page")) === null, "B) Carriers page edits need no registration id");
    check((await insert(c1, null, "delete")) === "carrier_registration_audit_action_check", "B) unknown actions are refused");
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
