// Display → Setup schedules, Map card and hidden cards
// (064_display_slide_schedules.sql): saving and re-reading per display,
// older Setup pages that don't send schedules, hiding/unhiding without
// touching Send to TV or schedules, and which slides the TV receives at
// exact instants — weekday and overnight windows — with speeds unchanged.
//
// Writes fixtures, so it refuses anything but a local database:
//   DATABASE_URL=<local throwaway db> JWT_SECRET=x npm run test:display-setup-schedules
import "dotenv/config";
import cookieParser from "cookie-parser";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { pool } from "../db";
import { startOfWeekMonday } from "../lib/displayPeriods";
import { isoWeekday } from "../lib/displaySchedule";
import { _clearSpeedCacheForTests, buildDisplaySlides } from "../lib/displaySpeedSlides";
import { addDaysToDateStr, calendarDateInAppTimezone, zonedWallTimeToUtc } from "../lib/timezone";
import { signSession, SESSION_COOKIE } from "../middleware/auth";
import greenhouseDisplaysRouter from "./greenhouseDisplays";
import greenhouseLiveRouter from "./greenhouseLive";

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
const ALWAYS = { enabled: false, days: [1, 2, 3, 4, 5, 6, 7], start: "06:00", end: "18:00" };

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "postgres://invalid").hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("Refusing to run: DATABASE_URL must be a local database.");

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/greenhouse/displays", greenhouseDisplaysRouter);
  app.use("/api/greenhouse", greenhouseLiveRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, p: string, opts: { body?: unknown; cookie?: string } = {}) {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
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
  const adminId = await employee("QA", `SchedAdmin ${RUN}`, "Administrator");
  const managerId = await employee("QA", `SchedManager ${RUN}`, "Manager");
  const basicId = await employee("QA", `SchedBasic ${RUN}`, "Employee");
  const ADMIN = cookieFor(adminId, "Administrator");
  const MANAGER = cookieFor(managerId, "Manager");
  const BASIC = cookieFor(basicId, "Employee");
  const workerA = await employee(`Sa${String(RUN).slice(-5)}`, `Alpha${RUN}`, "Employee");
  const workerB = await employee(`Sb${String(RUN).slice(-5)}`, `Beta${RUN}`, "Employee");

  const landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 300) returning id`, [`QA Sched Land ${RUN}`])).rows[0].id;
  const phaseId = (await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, 'P1', 300, 300) returning id`, [landId])).rows[0].id;
  const rowIds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    rowIds.push((await pool.query(`insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, $3, 5, 4, 200, 'vertical') returning id`, [phaseId, i, i * 10])).rows[0].id);
  }
  const activity = async (name: string) =>
    (await pool.query(`insert into activities (name, density_source, normal_speed, is_active, speed_unit) values ($1, 'stems', 500, true, 'stems/hour') returning id`, [name])).rows[0].id as string;
  const actDay = await activity(`QA Sched Day ${RUN}`);
  const actNight = await activity(`QA Sched Night ${RUN}`);
  const actAlways = await activity(`QA Sched Always ${RUN}`);

  // Work on last week's Tuesday, so the "last week" period has data whatever
  // day this runs.
  const today = calendarDateInAppTimezone(new Date());
  const lastTuesday = addDaysToDateStr(startOfWeekMonday(today), -6);
  const [ty, tm, td] = lastTuesday.split("-").map(Number);
  const tAt = (h: number, m = 0) => zonedWallTimeToUtc(ty, tm, td, h, m, 0);
  async function work(emp: string, act: string, start: Date, end: Date, row: string) {
    await pool.query(
      `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                 greenhouse_row_id, density_type, density_count_per_row)
       values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, 'stems', 400)`,
      [emp, act, start, end, row]
    );
  }
  await work(workerA, actDay, tAt(8), tAt(9), rowIds[0]);
  await work(workerB, actDay, tAt(9), tAt(11), rowIds[1]);
  await work(workerA, actNight, tAt(12), tAt(13), rowIds[2]);
  await work(workerB, actAlways, tAt(13), tAt(14), rowIds[3]);

  const employeeIds = [adminId, managerId, basicId, workerA, workerB];
  const createdActivityIds = [actDay, actNight, actAlways];
  let displayId: string | null = null;

  try {
    const created = await call("POST", "/api/greenhouse/displays", { cookie: ADMIN, body: { name: `QA Sched TV ${RUN}`, landId } });
    displayId = created.body.display.id as string;
    const token = created.body.token as string;
    const cfgPath = `/api/greenhouse/displays/${displayId}/slides-config`;
    const byId = (cfg: any, id: string) => cfg.activities.find((a: any) => a.activityId === id);

    // ---- Defaults: existing displays keep working --------------------------
    const cfg0 = await call("GET", cfgPath, { cookie: MANAGER });
    check(cfg0.status === 200 && cfg0.body.map.sendToTv === true && cfg0.body.map.schedule.enabled === false,
      "new/existing display: map sent to TV and Always show", cfg0.body.map);
    check(byId(cfg0.body, actDay).schedule.enabled === false && byId(cfg0.body, actDay).schedule.days.length === 7,
      "activity cards default to Always show", byId(cfg0.body, actDay).schedule);
    check(Array.isArray(cfg0.body.hiddenCards) && cfg0.body.hiddenCards.length === 0, "no cards hidden by default");
    check(typeof cfg0.body.timezone === "string" && cfg0.body.timezone.length > 0, "the editor is told the organization's time zone", cfg0.body.timezone);

    // ---- Save schedules, map card ------------------------------------------
    const base = (overrides: Record<string, unknown> = {}) => ({
      reportWeek: "last_week",
      reportIncludeToday: true,
      mapSlideSeconds: 25,
      map: { sendToTv: true, schedule: { enabled: true, days: [1, 2, 3, 4, 5], start: "06:00", end: "18:00" } },
      activities: [
        { activityId: actDay, sendToTv: true, minimumActivityHours: 0, slideSeconds: 15, schedule: { enabled: true, days: [1, 2, 3, 4, 5], start: "06:00", end: "18:00" } },
        { activityId: actNight, sendToTv: true, minimumActivityHours: 0, slideSeconds: 15, schedule: { enabled: true, days: [5], start: "22:00", end: "06:00" } },
        { activityId: actAlways, sendToTv: true, minimumActivityHours: 0, slideSeconds: 15, schedule: ALWAYS },
      ],
      ...overrides,
    });
    const saved = await call("PUT", cfgPath, { cookie: MANAGER, body: base() });
    check(saved.status === 200, "Manager saves schedules", saved);
    const reread = await call("GET", cfgPath, { cookie: ADMIN });
    check(JSON.stringify(reread.body.map) === JSON.stringify({ sendToTv: true, schedule: { enabled: true, days: [1, 2, 3, 4, 5], start: "06:00", end: "18:00" } }),
      "map card's Send to TV and schedule persist", reread.body.map);
    check(reread.body.mapSlideSeconds === 25, "map slide duration persists", reread.body.mapSlideSeconds);
    check(JSON.stringify(byId(reread.body, actNight).schedule) === JSON.stringify({ enabled: true, days: [5], start: "22:00", end: "06:00" }),
      "overnight activity schedule persists", byId(reread.body, actNight).schedule);

    // Per display: another display's settings are independent.
    const other = await call("POST", "/api/greenhouse/displays", { cookie: ADMIN, body: { name: `QA Sched TV2 ${RUN}`, landId } });
    const otherCfg = await call("GET", `/api/greenhouse/displays/${other.body.display.id}/slides-config`, { cookie: ADMIN });
    check(otherCfg.body.map.schedule.enabled === false && byId(otherCfg.body, actNight).schedule.enabled === false, "settings are per display", otherCfg.body.map);
    await pool.query(`delete from greenhouse_displays where id = $1`, [other.body.display.id]);

    // An older Setup page (no map / schedule fields) leaves them as saved.
    const legacy = await call("PUT", cfgPath, {
      cookie: ADMIN,
      body: {
        reportWeek: "last_week", reportIncludeToday: true, mapSlideSeconds: 30,
        activities: [{ activityId: actNight, sendToTv: true, minimumActivityHours: 0, slideSeconds: 20 }],
      },
    });
    check(legacy.status === 200 && legacy.body.map.schedule.enabled === true && byId(legacy.body, actNight).schedule.days.join() === "5"
      && byId(legacy.body, actNight).slideSeconds === 20,
      "an older Setup page without schedules never clears them", { map: legacy.body.map, night: byId(legacy.body, actNight) });

    // Validation.
    const noDays = await call("PUT", cfgPath, { cookie: ADMIN, body: base({ map: { sendToTv: true, schedule: { enabled: true, days: [], start: "06:00", end: "18:00" } } }) });
    check(noDays.status === 400 && /at least one day/.test(noDays.body?.error ?? ""), "a schedule needs at least one day", noDays);
    const badTime = await call("PUT", cfgPath, { cookie: ADMIN, body: base({ activities: [{ activityId: actDay, sendToTv: true, minimumActivityHours: 0, slideSeconds: 15, schedule: { enabled: true, days: [1], start: "25:00", end: "18:00" } }] }) });
    check(badTime.status === 400, "an invalid time is rejected", badTime);
    check((await call("PUT", cfgPath, { cookie: BASIC, body: base() })).status === 403, "Employee role cannot save schedules");

    // ---- Hide / unhide ------------------------------------------------------
    await call("PUT", cfgPath, { cookie: ADMIN, body: base() });
    const before = await pool.query(
      `select activity_id, send_to_tv, schedule_enabled, schedule_days, schedule_start, schedule_end from greenhouse_display_activity_slides where display_id = $1 order by activity_id`,
      [displayId]
    );
    const mapBefore = await pool.query(`select map_send_to_tv, map_schedule_enabled, map_schedule_days, map_schedule_start, map_schedule_end from greenhouse_displays where id = $1`, [displayId]);
    const hidePath = `/api/greenhouse/displays/${displayId}/setup-hidden-cards`;
    const hidden = await call("PUT", hidePath, { cookie: MANAGER, body: { hiddenCards: ["map", actNight, actNight] } });
    check(hidden.status === 200 && hidden.body.hiddenCards.join() === `map,${actNight}`, "Manager hides the map and an activity card (deduplicated)", hidden.body);
    check((await call("GET", cfgPath, { cookie: ADMIN })).body.hiddenCards.length === 2, "hidden cards persist after reopening the page");
    const after = await pool.query(
      `select activity_id, send_to_tv, schedule_enabled, schedule_days, schedule_start, schedule_end from greenhouse_display_activity_slides where display_id = $1 order by activity_id`,
      [displayId]
    );
    const mapAfter = await pool.query(`select map_send_to_tv, map_schedule_enabled, map_schedule_days, map_schedule_start, map_schedule_end from greenhouse_displays where id = $1`, [displayId]);
    check(JSON.stringify(after.rows) === JSON.stringify(before.rows) && JSON.stringify(mapAfter.rows) === JSON.stringify(mapBefore.rows),
      "hiding never changes Send to TV or schedules");
    const unhidden = await call("PUT", hidePath, { cookie: ADMIN, body: { hiddenCards: [] } });
    check(unhidden.status === 200 && unhidden.body.hiddenCards.length === 0, "Unhide all brings every card back", unhidden.body);
    check((await call("PUT", hidePath, { cookie: ADMIN, body: { hiddenCards: ["nope"] } })).status === 400, "unknown card ids are rejected");
    check((await call("PUT", hidePath, { cookie: BASIC, body: { hiddenCards: [] } })).status === 403, "Employee role cannot hide cards");

    // ---- What the TV gets, at exact instants --------------------------------
    // Schedules are judged at `now`; the reporting period still comes from
    // the real today, where the fixtures' work is.
    const display = async () => {
      const r = await pool.query(`select report_week, report_include_today, map_slide_seconds from greenhouse_displays where id = $1`, [displayId]);
      return r.rows[0];
    };
    const d0 = await display();
    const mapSchedule = { enabled: true, days: [1, 2, 3, 4, 5], start: "06:00", end: "18:00" };
    async function tvAt(now: Date, mapSendToTv = true) {
      _clearSpeedCacheForTests();
      return buildDisplaySlides(
        { id: displayId!, reportWeek: d0.report_week, reportIncludeToday: d0.report_include_today, mapSlideSeconds: d0.map_slide_seconds, mapSendToTv, mapSchedule },
        today,
        now
      );
    }
    const names = (p: Awaited<ReturnType<typeof tvAt>>) => p.slides.map((s) => s.activityId);
    // A Monday and the following Friday/Saturday, in the organization's zone.
    const monday = startOfWeekMonday(today);
    const [my, mm, md] = monday.split("-").map(Number);
    const wall = (dayOffset: number, h: number, mi = 0) => {
      const [y, m, d] = addDaysToDateStr(`${my}-${String(mm).padStart(2, "0")}-${String(md).padStart(2, "0")}`, dayOffset).split("-").map(Number);
      return zonedWallTimeToUtc(y, m, d, h, mi, 0);
    };
    check(isoWeekday(monday) === 1, "fixture: week starts Monday");

    const mon559 = await tvAt(wall(0, 5, 59));
    check(!names(mon559).includes(actDay) && names(mon559).includes(actAlways) && mon559.mapEnabled === false,
      "Monday 5:59 AM: day slide and map not yet; Always-show slide shown", { slides: names(mon559), map: mon559.mapEnabled });
    check(mon559.nextScheduleChangeAt === wall(0, 6).toISOString(), "next change reported: Monday 6:00 AM", mon559.nextScheduleChangeAt);
    const mon600 = await tvAt(wall(0, 6));
    check(names(mon600).includes(actDay) && mon600.mapEnabled === true, "Monday 6:00 AM: day slide and map start", { slides: names(mon600), map: mon600.mapEnabled });
    const fri1759 = await tvAt(wall(4, 17, 59));
    check(names(fri1759).includes(actDay), "Friday 5:59 PM: day slide still on");
    const fri1800 = await tvAt(wall(4, 18));
    check(!names(fri1800).includes(actDay) && fri1800.mapEnabled === false, "Friday 6:00 PM: day slide and map end");
    check(!names(fri1800).includes(actNight), "Friday 6 PM: overnight slide not yet");
    const fri2200 = await tvAt(wall(4, 22));
    check(names(fri2200).includes(actNight), "Friday 10 PM: overnight slide starts");
    const sat0559 = await tvAt(wall(5, 5, 59));
    check(names(sat0559).includes(actNight) && !names(sat0559).includes(actDay), "Saturday 5:59 AM: overnight slide continues, weekday slide off");
    const sat0600 = await tvAt(wall(5, 6));
    check(!names(sat0600).includes(actNight), "Saturday 6:00 AM: overnight slide ends");
    const satMapOff = await tvAt(wall(5, 12), false);
    check(satMapOff.mapEnabled === false, "map not sent to TV: never a slide");

    // Speeds are unchanged by scheduling: same figures as an Always-show run.
    const scheduled = mon600.slides.find((s) => s.activityId === actDay)!;
    await pool.query(`update greenhouse_display_activity_slides set schedule_enabled = false where display_id = $1 and activity_id = $2`, [displayId, actDay]);
    const unscheduled = (await tvAt(wall(5, 12))).slides.find((s) => s.activityId === actDay)!;
    check(JSON.stringify(scheduled.employees) === JSON.stringify(unscheduled.employees) && scheduled.employees.length === 2,
      "a scheduled slide's speeds are identical to the unscheduled slide's", { scheduled: scheduled.employees, unscheduled: unscheduled.employees });

    // Nothing eligible: no slides and no map.
    await pool.query(`update greenhouse_display_activity_slides set send_to_tv = false where display_id = $1`, [displayId]);
    const empty = await tvAt(wall(5, 12));
    check(empty.slides.length === 0 && empty.mapEnabled === false, "nothing scheduled: empty slides and map off (TV shows the notice)", empty);

    // ---- The token route reflects saved settings, no restart --------------
    await call("PUT", cfgPath, {
      cookie: ADMIN,
      body: base({
        map: { sendToTv: false, schedule: ALWAYS },
        activities: [{ activityId: actAlways, sendToTv: true, minimumActivityHours: 0, slideSeconds: 15, schedule: ALWAYS }],
      }),
    });
    const live = await call("GET", `/api/greenhouse/display/${token}/slides`);
    check(live.status === 200 && live.body.mapEnabled === false && live.body.slides.map((s: any) => s.activityId).join() === actAlways,
      "TV route: map off and only the Always-show slide after saving", { map: live.body.mapEnabled, slides: live.body.slides?.map((s: any) => s.activityName) });
    check(live.body.nextScheduleChangeAt === null, "TV route: no schedule → no next change", live.body.nextScheduleChangeAt);
  } finally {
    const tryDelete = async (label: string, sql: string, params: unknown[]) => {
      try {
        await pool.query(sql, params);
      } catch (err) {
        console.error(`cleanup ${label} failed:`, err instanceof Error ? err.message : err);
      }
    };
    if (displayId) await tryDelete("greenhouse_displays", `delete from greenhouse_displays where id = $1`, [displayId]);
    await tryDelete("time_entries", `delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
    await tryDelete("greenhouse_display_activity_slides", `delete from greenhouse_display_activity_slides where activity_id = any($1::uuid[])`, [createdActivityIds]);
    await tryDelete("activities", `delete from activities where id = any($1::uuid[])`, [createdActivityIds]);
    await tryDelete("employees", `delete from employees where id = any($1::uuid[])`, [employeeIds]);
    await tryDelete("greenhouse_rows", `delete from greenhouse_rows where phase_id = $1`, [phaseId]);
    await tryDelete("greenhouse_phases", `delete from greenhouse_phases where id = $1`, [phaseId]);
    await tryDelete("greenhouse_lands", `delete from greenhouse_lands where id = $1`, [landId]);
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
