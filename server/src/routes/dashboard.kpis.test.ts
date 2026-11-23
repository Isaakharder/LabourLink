// Dashboard KPI strip (GET /api/dashboard/kpis, lib/dashboardKpis.ts):
// "KG weighed today" sums the net kg of valid weighings on the
// greenhouse-local date: trial and live, credited, pending, needs review
// and expired all count; voided and duplicate never do; a weighing just
// outside the local day's boundaries never counts. Null (card hidden) for
// a greenhouse without LabourLink Scale. Administrator/Manager only.
// RUN_ID-suffixed fixtures; sums are compared as deltas so other data on
// the shared test database never affects the result.
//
// Run with: npm run test:dashboard-kpis
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { addDaysToDateStr, calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import { getKgWeighedOnDate } from "../lib/dashboardKpis";
import dashboardRouter from "./dashboard";

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
const TODAY = calendarDateInAppTimezone(new Date());
const DAY = addDaysToDateStr(TODAY, -1200 - (RUN_ID % 300));

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/dashboard", dashboardRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ids = { employees: [] as string[], carriers: [] as string[], weighings: [] as string[] };
  let stationId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    async function employee(role: string, first: string) {
      const roleId = (await pool.query(`select id from security_roles where name = $1`, [role])).rows[0].id;
      const id = (
        await pool.query(`insert into employees (first_name, last_name, security_role_id, team_role_id) values ($1, $2, $3, $4) returning id`, [
          first,
          `KPI ${RUN_ID}`,
          roleId,
          teamRoleId,
        ])
      ).rows[0].id as string;
      ids.employees.push(id);
      return { id, token: signSession({ id, firstName: first, lastName: `KPI ${RUN_ID}`, securityRole: role, teamRole: "Team Member" }) };
    }
    const admin = await employee("Administrator", "Ada");
    const manager = await employee("Manager", "Max");
    const worker = await employee("Employee", "Eve");
    const get = (path: string, token?: string) => fetch(`${BASE}${path}`, { headers: token ? { cookie: `labourlink_session=${token}` } : {} });

    stationId = (
      await pool.query(`insert into scale_stations (name, token_hash, credits_enabled) values ($1, $2, false) returning id`, [`QA KPI ${RUN_ID}`, `h-kpi-${RUN_ID}`])
    ).rows[0].id as string;
    const carrier = (await pool.query(`insert into carriers (name, tare_weight_kg) values ($1, 150) returning id`, [`QA KPI ${RUN_ID} Bin`])).rows[0].id as string;
    ids.carriers.push(carrier);

    async function weighing(at: Date, netG: number, status: string, opts: { live?: boolean; duplicate?: boolean } = {}) {
      const id = (
        await pool.query(
          `insert into scale_weighings (station_id, station_weighing_id, carrier_id, rfid_tag, gross_g, tare_g, net_g, weighed_at, pending_until,
             credits_live, status, employee_id, is_duplicate)
           values ($1, $2, $3, 'T', $4::int + 150000, 150000, $4, $5, $5::timestamptz + interval '24 hours', $6, $7, $8, $9) returning id`,
          [stationId, randomUUID(), carrier, netG, at, opts.live ?? false, status, ["credited", "voided"].includes(status) ? worker.id : null, opts.duplicate ?? false]
        )
      ).rows[0].id as string;
      ids.weighings.push(id);
      return id;
    }

    // ---- Lib: one fixed past local day ----
    const before = (await getKgWeighedOnDate(pool, DAY))!;
    check(before !== null, "with an active station the KPI applies even on a day with no weighings");
    const { start, end } = getDayBoundsUtc(DAY);
    const at = (h: number, m = 0) => new Date(start.getTime() + (h * 60 + m) * 60_000);

    await weighing(at(8), 20000, "credited", { live: true }); // live credit
    await weighing(at(8, 10), 18500, "credited"); // trial credit
    await weighing(at(9), 21250, "pending");
    await weighing(at(10), 19000, "needs_review");
    await weighing(at(11), 17000, "expired");
    await weighing(at(12), 50000, "voided"); // excluded
    await weighing(at(13), 40000, "needs_review", { duplicate: true }); // excluded
    await weighing(at(13), 30000, "expired", { duplicate: true }); // excluded
    // Just outside the local day (the UTC date of these may well be DAY).
    await weighing(new Date(start.getTime() - 60_000), 11111, "pending");
    await weighing(end, 22222, "pending");
    // The very first and last instants of the local day count.
    await weighing(start, 1000, "pending");
    await weighing(new Date(end.getTime() - 1), 500, "pending");

    const after = (await getKgWeighedOnDate(pool, DAY))!;
    const expectedG = 20000 + 18500 + 21250 + 19000 + 17000 + 1000 + 500;
    check(Math.round((after.netKg - before.netKg) * 1000) === expectedG, "sum = trial + live, credited/pending/needs review/expired; no voided or duplicate", {
      before,
      after,
      expectedG,
    });
    check(after.bins - before.bins === 7, "bins counts the same seven weighings", { before: before.bins, after: after.bins });
    check(after.lastWeighedAt === new Date(end.getTime() - 1).toISOString(), "lastWeighedAt is the latest valid weighing of the day", after.lastWeighedAt);
    const dayAfter = (await getKgWeighedOnDate(pool, addDaysToDateStr(DAY, 1)))!;
    const dayBefore = (await getKgWeighedOnDate(pool, addDaysToDateStr(DAY, -1)))!;
    check(dayAfter.bins >= 1 && dayBefore.bins >= 1, "the weighings just outside the day belong to the neighbouring local days", { dayAfter, dayBefore });

    // No LabourLink Scale: no active station and nothing weighed that day.
    // Checked in a transaction that is always rolled back.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("update scale_stations set is_active = false where is_active");
      const emptyDay = addDaysToDateStr(DAY, -5000);
      check((await getKgWeighedOnDate(client, emptyDay)) === null, "no active station and no weighings -> null (card hidden)");
      check((await getKgWeighedOnDate(client, DAY))?.bins === after.bins, "an inactive station's weighings that day still show");
    } finally {
      await client.query("rollback");
      client.release();
    }

    // ---- Route: today, permissions, updates as weighings arrive ----
    check((await get("/api/dashboard/kpis")).status === 401, "signed out -> 401");
    check((await get("/api/dashboard/kpis", worker.token)).status === 403, "Employee -> 403");
    const r1 = await get("/api/dashboard/kpis", manager.token);
    check(r1.status === 200, "Manager -> 200", r1.status);
    const b1 = (await r1.json()) as { date: string; kgWeighedToday: { netKg: number; bins: number } | null };
    check(b1.date === TODAY, "date is today's greenhouse-local date", b1.date);
    check(b1.kgWeighedToday !== null && typeof b1.kgWeighedToday?.netKg === "number", "kgWeighedToday present with a station", b1);

    await weighing(new Date(Date.now() - 1000), 23456, "pending");
    const b2 = (await (await get("/api/dashboard/kpis", admin.token)).json()) as typeof b1;
    check(
      Math.round((b2.kgWeighedToday!.netKg - b1.kgWeighedToday!.netKg) * 1000) === 23456 && b2.kgWeighedToday!.bins === b1.kgWeighedToday!.bins + 1,
      "a new weighing shows on the next refresh",
      { b1, b2 }
    );
  } finally {
    const tryDelete = async (q: string, p: unknown[]) => {
      try {
        await pool.query(q, p);
      } catch (err) {
        console.error("cleanup step failed:", q, err);
      }
    };
    await tryDelete(`delete from scale_weighing_events where weighing_id = any($1::uuid[])`, [ids.weighings]);
    await tryDelete(`delete from scale_weighings where id = any($1::uuid[])`, [ids.weighings]);
    await tryDelete(`delete from carriers where id = any($1::uuid[])`, [ids.carriers]);
    if (stationId) await tryDelete(`delete from scale_stations where id = $1`, [stationId]);
    await tryDelete(`delete from employees where id = any($1::uuid[])`, [ids.employees]);
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
