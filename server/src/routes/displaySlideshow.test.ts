// TV slideshow (059_display_slideshow.sql): per-display slide settings,
// relative map dates, the token-authed /slides endpoint, and — the key
// guarantee — ranking figures identical to the Productive TV endpoints for
// the same dates.
//
// Writes fixtures, so it refuses anything but a local database:
//   DATABASE_URL=<local throwaway db> JWT_SECRET=x npm run test:display-slideshow
import "dotenv/config";
import { randomBytes } from "crypto";
import cookieParser from "cookie-parser";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { pool } from "../db";
import { hashIntegrationToken } from "../lib/integrationToken";
import { resolveMapPreset, resolveReportingPeriod, startOfWeekMonday } from "../lib/displayPeriods";
import { _clearSpeedCacheForTests } from "../lib/displaySpeedSlides";
import { addDaysToDateStr, calendarDateInAppTimezone, zonedWallTimeToUtc } from "../lib/timezone";
import { signSession, SESSION_COOKIE } from "../middleware/auth";
import greenhouseDisplaysRouter from "./greenhouseDisplays";
import greenhouseLiveRouter from "./greenhouseLive";
import integrationsRouter, { PICKING_ACTIVITY_NAME, PRUNING_ACTIVITY_NAME } from "./integrations";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 1500) : "");
  }
}

const RUN = Date.now();
// Per-run first names, so re-running against the same database never mixes
// in an earlier run's workers.
const TAG = String(RUN).slice(-6);
const ANA = `Ana${TAG}`;
const BRUNO = `Bruno${TAG}`;
const CARLA = `Carla${TAG}`;

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "postgres://invalid").hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("Refusing to run: DATABASE_URL must be a local database.");

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/greenhouse/displays", greenhouseDisplaysRouter);
  app.use("/api/greenhouse", greenhouseLiveRouter);
  app.use("/api/integrations", integrationsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, p: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}) {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  // ---- Fixtures ------------------------------------------------------------
  const role = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
  async function employee(first: string, last: string, roleName: string) {
    const { rows } = await pool.query(
      `insert into employees (first_name, last_name, security_role_id, team_role_id) values ($1, $2, $3, 1) returning id`,
      [first, last, await role(roleName)]
    );
    return rows[0].id as string;
  }
  const cookieFor = (id: string, securityRole: string) =>
    `${SESSION_COOKIE}=${signSession({ id, firstName: "QA", lastName: "QA", securityRole, teamRole: "Team Member" })}`;

  const adminId = await employee("QA", `DisplayAdmin ${RUN}`, "Administrator");
  const managerId = await employee("QA", `DisplayManager ${RUN}`, "Manager");
  const basicId = await employee("QA", `DisplayBasic ${RUN}`, "Employee");
  const ADMIN = cookieFor(adminId, "Administrator");
  const MANAGER = cookieFor(managerId, "Manager");
  const BASIC = cookieFor(basicId, "Employee");

  const workerA = await employee(ANA, `Alvarez${RUN}`, "Employee");
  const workerB = await employee(BRUNO, `Bravo${RUN}`, "Employee");
  const workerC = await employee(CARLA, `Castro${RUN}`, "Employee");

  const landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 300) returning id`, [`QA Display Land ${RUN}`])).rows[0].id;
  const phaseId = (await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, 'P1', 300, 300) returning id`, [landId])).rows[0].id;
  const rowIds: string[] = [];
  for (let i = 1; i <= 6; i++) {
    rowIds.push((await pool.query(`insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, $3, 5, 4, 200, 'vertical') returning id`, [phaseId, i, i * 10])).rows[0].id);
  }

  async function activity(name: string, densitySource: string | null, normalSpeed: number | null, active = true) {
    const found = await pool.query(`select id from activities where lower(trim(name)) = lower(trim($1))`, [name]);
    if (found.rows[0]) {
      await pool.query(`update activities set density_source = $2, normal_speed = $3, is_active = $4, speed_unit = $5 where id = $1`, [
        found.rows[0].id, densitySource, normalSpeed, active, densitySource ? `${densitySource}/hour` : "tasks/hour",
      ]);
      return found.rows[0].id as string;
    }
    return (await pool.query(
      `insert into activities (name, density_source, normal_speed, is_active, speed_unit) values ($1, $2, $3, $4, $5) returning id`,
      [name, densitySource, normalSpeed, active, densitySource ? `${densitySource}/hour` : "tasks/hour"]
    )).rows[0].id as string;
  }
  const pruning = await activity(PRUNING_ACTIVITY_NAME, "stems", 500);
  const picking = await activity(PICKING_ACTIVITY_NAME, "stems", 180);
  const cleaning = await activity(`QA Display Cleaning ${RUN}`, null, 20);
  const idle = await activity(`QA Display Idle ${RUN}`, "stems", 300);
  const retired = await activity(`QA Display Retired ${RUN}`, "stems", 300, false);

  // All work lands on last week's Tuesday (local time), so "last week" is a
  // deterministic period wherever in the week this test runs.
  const today = calendarDateInAppTimezone(new Date());
  const lastTuesday = addDaysToDateStr(startOfWeekMonday(today), -6);
  const [ty, tm, td] = lastTuesday.split("-").map(Number);
  const at = (h: number, m = 0) => zonedWallTimeToUtc(ty, tm, td, h, m, 0);
  async function work(emp: string, act: string, start: Date, end: Date | null, row: string | null, stems: number | null) {
    await pool.query(
      `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                 greenhouse_row_id, density_type, density_count_per_row)
       values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, $6, $7)`,
      [emp, act, start, end, row, stems ? "stems" : null, stems]
    );
  }
  await work(workerA, pruning, at(8), at(9), rowIds[0], 400);
  await work(workerA, pruning, at(9), at(9, 30), rowIds[1], 400);
  await work(workerB, pruning, at(8), at(10), rowIds[2], 400);
  await work(workerC, pruning, at(10), at(10, 6), rowIds[3], 400); // 0.1 h: under a 0.5 h minimum
  await work(workerC, picking, at(11), null, rowIds[4], 400); // still open: work, but no speed
  await work(workerB, cleaning, at(13), at(14), null, null); // no density source at all

  const tokenPlain = randomBytes(32).toString("base64url");
  const tokenId = (await pool.query(`insert into integration_tokens (name, token_hash, is_active) values ($1, $2, true) returning id`, [`QA display ${RUN}`, hashIntegrationToken(tokenPlain)])).rows[0].id;
  const employeeIds = [adminId, managerId, basicId, workerA, workerB, workerC];
  const createdActivityIds = [cleaning, idle, retired];
  let createdDisplayId: string | null = null;

  try {
    // ---- Display creation (Administrator only, unchanged) -------------------
    const createByManager = await call("POST", "/api/greenhouse/displays", { cookie: MANAGER, body: { name: "x", landId } });
    check(createByManager.status === 403, "Manager still cannot create a display", createByManager);
    const created = await call("POST", "/api/greenhouse/displays", { cookie: ADMIN, body: { name: `QA TV ${RUN}`, landId } });
    check(created.status === 201, "Administrator creates a display", created);
    const displayId: string = created.body.display.id;
    createdDisplayId = displayId;
    let key: string = created.body.token;
    check(created.body.display.datePreset === null && created.body.display.reportWeek === "this_week" && created.body.display.reportIncludeToday === true,
      "new display defaults: fixed map dates, This week including today", created.body.display);

    // ---- Settings defaults / permissions / persistence ----------------------
    const cfg0 = await call("GET", `/api/greenhouse/displays/${displayId}/slides-config`, { cookie: MANAGER });
    const byId = (c: any, id: string) => c.activities.find((a: any) => a.activityId === id);
    check(cfg0.status === 200 && byId(cfg0.body, pruning)?.sendToTv === false && byId(cfg0.body, pruning)?.targetOverride === null &&
      byId(cfg0.body, pruning)?.normalSpeed === 500, "every active activity listed, not sent to TV by default, target from normal speed", cfg0.body);
    check(!byId(cfg0.body, retired), "inactive activities are not listed", cfg0.body.activities.map((a: any) => a.name));
    check(byId(cfg0.body, pruning)?.atTargetColor === "#15803d" && byId(cfg0.body, pruning)?.belowTargetColor === "#dc2626",
      "bar colours default to green (at/above) and red (below)", byId(cfg0.body, pruning));
    check((await call("GET", `/api/greenhouse/displays/${displayId}/slides-config`, { cookie: BASIC })).status === 403, "Employee role cannot read slide settings");
    check((await call("PUT", `/api/greenhouse/displays/${displayId}/slides-config`, { cookie: BASIC, body: {} })).status === 403, "Employee role cannot save slide settings");

    // Before anything is sent to the TV the slideshow is map-only.
    const mapOnly = await call("GET", `/api/greenhouse/display/${key}/slides`);
    check(mapOnly.status === 200 && mapOnly.body.slides.length === 0, "nothing sent to TV: no ranking slides (map only)", mapOnly.body);

    const setting = (id: string, extra: Record<string, unknown> = {}) => ({
      activityId: id, sendToTv: true, targetOverride: null, minimumActivityHours: 0, topN: null, slideSeconds: 15, ...extra,
    });
    const saveBody = (week: string, includeToday: boolean, acts: unknown[]) => ({ reportWeek: week, reportIncludeToday: includeToday, mapSlideSeconds: 25, activities: acts });
    const saved = await call("PUT", `/api/greenhouse/displays/${displayId}/slides-config`, {
      cookie: MANAGER,
      body: saveBody("last_week", true, [
        setting(pruning, { targetOverride: 650, minimumActivityHours: 0.5, slideSeconds: 20 }),
        setting(picking), setting(cleaning), setting(idle), setting(retired),
      ]),
    });
    check(saved.status === 200 && byId(saved.body, pruning).sendToTv === true && byId(saved.body, pruning).targetOverride === 650 &&
      byId(saved.body, pruning).minimumActivityHours === 0.5 && byId(saved.body, pruning).slideSeconds === 20 && saved.body.mapSlideSeconds === 25,
      "Manager saves settings and they persist", saved.body);
    const reread = await call("GET", `/api/greenhouse/displays/${displayId}/slides-config`, { cookie: ADMIN });
    check(byId(reread.body, picking).sendToTv === true && reread.body.reportWeek === "last_week", "settings re-read from the server", reread.body);
    const normal = await pool.query(`select normal_speed from activities where id = $1`, [pruning]);
    check(Number(normal.rows[0].normal_speed) === 500, "a display target override never changes the activity's normal speed", normal.rows);
    const badTopN = await call("PUT", `/api/greenhouse/displays/${displayId}/slides-config`, { cookie: ADMIN, body: saveBody("last_week", true, [setting(pruning, { topN: 0 })]) });
    check(badTopN.status === 400, "invalid Top N rejected", badTopN);

    // ---- Bar colours (060) ------------------------------------------------------
    for (const bad of ["red", "#12345", "#gggggg", "15803d", 42]) {
      const r = await call("PUT", `/api/greenhouse/displays/${displayId}/slides-config`, {
        cookie: ADMIN, body: saveBody("last_week", true, [setting(pruning, { atTargetColor: bad })]),
      });
      check(r.status === 400 && /hex colour/.test(r.body?.error ?? ""), `invalid colour rejected: ${JSON.stringify(bad)}`, r);
    }
    const coloured = await call("PUT", `/api/greenhouse/displays/${displayId}/slides-config`, {
      cookie: MANAGER,
      body: saveBody("last_week", true, [
        setting(pruning, { targetOverride: 650, minimumActivityHours: 0.5, slideSeconds: 20, atTargetColor: "#1D4ED8", belowTargetColor: "#F80" }),
        setting(picking), setting(cleaning), setting(idle), setting(retired),
      ]),
    });
    check(coloured.status === 200 && byId(coloured.body, pruning).atTargetColor === "#1d4ed8" && byId(coloured.body, pruning).belowTargetColor === "#ff8800",
      "colours saved per activity per display, normalised to lowercase #rrggbb", byId(coloured.body, pruning));
    check(byId(coloured.body, picking).atTargetColor === "#15803d", "an activity saved without colours (older client) keeps the defaults", byId(coloured.body, picking));
    const colourReread = await call("GET", `/api/greenhouse/displays/${displayId}/slides-config`, { cookie: ADMIN });
    check(byId(colourReread.body, pruning).belowTargetColor === "#ff8800", "colours persist on re-read", byId(colourReread.body, pruning));

    // ---- Slides for last week -------------------------------------------------
    _clearSpeedCacheForTests();
    const slides = await call("GET", `/api/greenhouse/display/${key}/slides`);
    const period = resolveReportingPeriod("last_week", true, today);
    check(slides.status === 200 && slides.body.period.dateStart === period.dateStart && slides.body.period.dateEnd === period.dateEnd,
      "slides report last week's Monday–Sunday", slides.body.period);
    const names = slides.body.slides.map((s: any) => s.activityName);
    check(!names.includes(`QA Display Idle ${RUN}`), "an enabled activity with no work in the period is skipped", names);
    check(!names.includes(`QA Display Retired ${RUN}`), "an inactive activity is never shown, even if it was sent to TV", names);
    const pr = slides.body.slides.find((s: any) => s.activityId === pruning);
    const pk = slides.body.slides.find((s: any) => s.activityId === picking);
    const cl = slides.body.slides.find((s: any) => s.activityId === cleaning);
    check(pr?.status === "ok" && pr.speedUnit === "stems/hour" && pr.target === 650 && pr.slideSeconds === 20, "pruning slide: stems/hour, override target, own duration", pr);
    check(pr?.atTargetColor === "#1d4ed8" && pr?.belowTargetColor === "#ff8800", "the TV payload carries this display's bar colours", pr);
    check(pr?.employees.map((e: any) => `${e.firstName} ${e.lastInitial}`).join(",") === `${ANA} A.,${BRUNO} B.` && pr.belowMinimumHours === 1,
      "ranked fastest first, 0.1 h worker left out by the 0.5 h minimum", pr);
    check(pr?.employees[0]?.displayName === `${ANA} Alvarez${RUN}`, "ranking slides carry the full display name", pr?.employees[0]);
    // An open-only visit has no finished Activity Hours yet, so the report
    // doesn't count Carla at all (employeesWithoutSpeed 0, same as the
    // endpoint below) — the slide still exists because work is recorded.
    check(pk?.status === "no_speed" && pk.employees.length === 0 && /in progress/.test(pk.notice),
      "picking with only an open visit: a notice, not a zero speed", pk);
    check(pk?.reason === "not_calculable", "open-only work is reported as not calculable yet", pk?.reason);
    check(cl?.status === "no_speed" && cl.reason === "no_density" && /no stems or plants count/.test(cl.notice), "activity without a density source: explanatory notice", cl);
    check(slides.body.mapSlideSeconds === 25, "map slide duration returned", slides.body.mapSlideSeconds);

    // ---- Identical to the Productive TV endpoints for the same dates ----------
    const ptv = await call("GET", `/api/integrations/productive-tv/pruning-speed?from=${period.dateStart}&to=${period.dateEnd}`, { bearer: tokenPlain });
    const mine = new Set([ANA, BRUNO, CARLA]);
    const ptvMine = (ptv.body?.employees ?? []).filter((e: any) => mine.has(e.employeeName.split(" ")[0]));
    const ptvByFirst = new Map(ptvMine.map((e: any) => [e.employeeName.split(" ")[0], e]));
    const allPruning = await call("PUT", `/api/greenhouse/displays/${displayId}/slides-config`, { cookie: ADMIN, body: saveBody("last_week", true, [setting(pruning)]) });
    check(allPruning.status === 200, "minimum hours reset to compare everyone");
    _clearSpeedCacheForTests();
    const prAll = (await call("GET", `/api/greenhouse/display/${key}/slides`)).body.slides.find((s: any) => s.activityId === pruning);
    const matches = prAll.employees.length === ptvMine.length && prAll.employees.every((e: any) => {
      const p: any = ptvByFirst.get(e.firstName);
      return p && p.stemsPerHour === e.speed && p.activityHours === e.activityHours && p.stemsCounted === e.quantityCounted;
    });
    check(ptv.status === 200 && ptvMine.length === 3 && matches, "pruning speeds, hours and stems equal the Productive TV endpoint for identical dates", { slide: prAll.employees, ptv: ptvMine });
    const ptvPick = await call("GET", `/api/integrations/productive-tv/picking-speed?from=${period.dateStart}&to=${period.dateEnd}`, { bearer: tokenPlain });
    check(ptvPick.status === 200 && !(ptvPick.body.employees ?? []).some((e: any) => e.employeeName.startsWith(`${CARLA} `)) &&
      pk.employeesWithoutSpeed === ptvPick.body.employeesWithoutSpeed,
      "picking: the endpoint also gives Carla no speed, with the same without-speed count", ptvPick.body);

    const top1 = await call("PUT", `/api/greenhouse/displays/${displayId}/slides-config`, { cookie: ADMIN, body: saveBody("last_week", true, [setting(pruning, { topN: 1 })]) });
    check(top1.status === 200, "Top N saved");
    const prTop = (await call("GET", `/api/greenhouse/display/${key}/slides`)).body.slides.find((s: any) => s.activityId === pruning);
    check(prTop.employees.length === 1 && prTop.employees[0].firstName === prAll.employees[0].firstName, "Top 1 shows only the fastest", prTop.employees);

    // ---- This week: no work yet -> map only ------------------------------------
    await call("PUT", `/api/greenhouse/displays/${displayId}/slides-config`, { cookie: ADMIN, body: saveBody("this_week", true, [setting(pruning)]) });
    const thisWeek = await call("GET", `/api/greenhouse/display/${key}/slides`);
    check(thisWeek.body.period.dateStart === startOfWeekMonday(today) && thisWeek.body.period.dateEnd === today && thisWeek.body.slides.length === 0,
      "this week including today, no work yet: no ranking slides (map only)", thisWeek.body);

    // ---- Map dates: fixed stays fixed, presets advance ---------------------------
    const fixed = await call("PUT", `/api/greenhouse/displays/${displayId}`, {
      cookie: MANAGER, body: { landId, activityId: null, dateStart: "2026-08-17", dateEnd: "2026-08-23", rotationDegrees: 90 },
    });
    check(fixed.status === 200 && fixed.body.display.datePreset === null, "publishing without a preset (old office page) = fixed dates", fixed.body);
    const fixedState = await call("GET", `/api/greenhouse/display/${key}/state`);
    check(fixedState.body.dateStart === "2026-08-17" && fixedState.body.dateEnd === "2026-08-23" && fixedState.body.datePreset === null,
      "a fixed range is served exactly as published", fixedState.body);
    const relative = await call("PUT", `/api/greenhouse/displays/${displayId}`, {
      cookie: MANAGER, body: { landId, activityId: null, dateStart: "2000-01-01", dateEnd: "2000-01-01", rotationDegrees: 0, datePreset: "thisWeek" },
    });
    const expectWeek = resolveMapPreset("thisWeek", today);
    check(relative.status === 200 && relative.body.display.datePreset === "thisWeek" && relative.body.display.dateStart === expectWeek.dateStart,
      "a preset publishes its own resolved dates", relative.body);
    await pool.query(`update greenhouse_displays set date_start = '2026-01-05', date_end = '2026-01-11' where id = $1`, [displayId]);
    const advanced = await call("GET", `/api/greenhouse/display/${key}/state`);
    check(advanced.body.dateStart === expectWeek.dateStart && advanced.body.dateEnd === expectWeek.dateEnd,
      "a preset advances by itself: stale stored dates are ignored", advanced.body);
    const badPreset = await call("PUT", `/api/greenhouse/displays/${displayId}`, { cookie: MANAGER, body: { landId, dateStart: today, dateEnd: today, datePreset: "tomorrow" } });
    check(badPreset.status === 400, "unknown preset rejected", badPreset);

    // ---- Revocation and regeneration --------------------------------------------
    await call("PATCH", `/api/greenhouse/displays/${displayId}`, { cookie: ADMIN, body: { isActive: false } });
    const off = await call("GET", `/api/greenhouse/display/${key}/slides`);
    check(off.status === 404 && (await call("GET", `/api/greenhouse/display/${key}/state`)).status === 404, "deactivated display: slides and map both 404", off);
    await call("PATCH", `/api/greenhouse/displays/${displayId}`, { cookie: ADMIN, body: { isActive: true } });
    const regen = await call("POST", `/api/greenhouse/displays/${displayId}/regenerate-key`, { cookie: ADMIN });
    const oldKey = key;
    key = regen.body.token;
    check((await call("GET", `/api/greenhouse/display/${oldKey}/slides`)).status === 404, "regenerated: the old link stops working");
    check((await call("GET", `/api/greenhouse/display/${key}/slides`)).status === 200, "regenerated: the new link works");

    const dToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    check(today === dToday || process.env.APP_TIMEZONE !== undefined, "today is computed in the organization timezone", { today, dToday });
  } finally {
    // Remove this run's fixtures (children first) so re-runs start clean;
    // each step is independent so one failure never blocks the rest.
    const tryDelete = async (label: string, sql: string, params: unknown[]) => {
      try {
        await pool.query(sql, params);
      } catch (err) {
        console.error(`cleanup ${label} failed:`, err instanceof Error ? err.message : err);
      }
    };
    if (createdDisplayId) await tryDelete("greenhouse_displays", `delete from greenhouse_displays where id = $1`, [createdDisplayId]);
    await tryDelete("time_entries", `delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
    await tryDelete("greenhouse_display_activity_slides", `delete from greenhouse_display_activity_slides where activity_id = any($1::uuid[])`, [createdActivityIds]);
    await tryDelete("activities", `delete from activities where id = any($1::uuid[])`, [createdActivityIds]);
    await tryDelete("employees", `delete from employees where id = any($1::uuid[])`, [employeeIds]);
    await tryDelete("greenhouse_rows", `delete from greenhouse_rows where phase_id = $1`, [phaseId]);
    await tryDelete("greenhouse_phases", `delete from greenhouse_phases where id = $1`, [phaseId]);
    await tryDelete("greenhouse_lands", `delete from greenhouse_lands where id = $1`, [landId]);
    await tryDelete("integration_tokens", `delete from integration_tokens where id = $1`, [tokenId]);
    server.close();
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
