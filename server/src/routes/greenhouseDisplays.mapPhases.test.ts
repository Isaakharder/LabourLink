// Integration test for Display → Map phase selection
// (063_display_map_phases.sql): PUT /api/greenhouse/displays/:id phaseIds,
// GET /api/greenhouse/displays, and the TV endpoint
// GET /api/greenhouse/display/:key/state (+ /slides untouched).
//
// Covers: existing displays keep every phase (null); single, multiple and
// all-phase selections, saved per display (two TVs on one land differ);
// "all" stored as null; at least one phase required; phases must be active
// phases of the display's land; an older client omitting phaseIds keeps the
// selection, a land change resets it; the TV gets only the selected phases
// and a block legend counted over them; a selected phase deactivated later
// falls back to all phases instead of a blank map; rotation, dates, activity
// filter and TV link keep working.
//
// Run with: npm run test:greenhouse-display-map-phases
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import greenhouseDisplaysRouter from "./greenhouseDisplays";
import greenhouseLiveRouter from "./greenhouseLive";

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

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/greenhouse/displays", greenhouseDisplaysRouter);
  app.use("/api/greenhouse", greenhouseLiveRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Cookie: `labourlink_session=${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const displayIds: string[] = [];
  const landIds: string[] = [];
  const phaseIds: string[] = [];
  const rowIds: string[] = [];
  let blockId: string | undefined;
  let adminId: string | undefined;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const adminRoleId = (await pool.query(`select id from security_roles where name = 'Administrator'`)).rows[0].id;
    adminId = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, is_active)
         values ('QA', $1, $2, $3, $4, true) returning id`,
        [`Map Phases Admin ${RUN_ID}`, `qa-map-phases-${RUN_ID}@test.local`, adminRoleId, teamRoleId]
      )
    ).rows[0].id;
    const token = signSession({ id: adminId!, firstName: "QA", lastName: `Map Phases Admin ${RUN_ID}`, securityRole: "Administrator", teamRole: "Team Member" });

    async function land(name: string) {
      const id = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 400) returning id`, [`${name} ${RUN_ID}`])).rows[0].id;
      landIds.push(id);
      return id as string;
    }
    async function phase(landId: string, name: string, x: number, y: number, sort: number, active = true) {
      const id = (
        await pool.query(
          `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, x_feet_from_west, y_feet_from_north, sort_order, is_active)
           values ($1, $2, 100, 150, $3, $4, $5, $6) returning id`,
          [landId, name, x, y, sort, active]
        )
      ).rows[0].id;
      phaseIds.push(id);
      return id as string;
    }
    async function row(phaseId: string, n: number) {
      const id = (
        await pool.query(
          `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 4, 20, 'horizontal') returning id`,
          [phaseId, n, n * 5]
        )
      ).rows[0].id;
      rowIds.push(id);
      return id as string;
    }

    const landA = await land("QA Map Phases Land A");
    const landB = await land("QA Map Phases Land B");
    const p1 = await phase(landA, "Phase 1", 0, 0, 1);
    const p2 = await phase(landA, "Phase 2", 200, 0, 2);
    const p3 = await phase(landA, "Phase 3", 0, 150, 3);
    const p4inactive = await phase(landA, "Phase 4 (inactive)", 200, 150, 4, false);
    const q1 = await phase(landB, "Other land phase", 0, 0, 1);
    const r1 = await row(p1, 1);
    await row(p2, 2);
    const r3 = await row(p3, 3);
    blockId = (await pool.query(`insert into employee_blocks (name, color_key) values ($1, 'slate') returning id`, [`QA Map Phases Block ${RUN_ID}`])).rows[0].id;
    await pool.query(`insert into employee_block_rows (block_id, greenhouse_row_id) values ($1, $2), ($1, $3)`, [blockId, r1, r3]);

    async function createDisplay(name: string) {
      const r = await call("POST", "/api/greenhouse/displays", token, { name: `${name} ${RUN_ID}`, landId: landA });
      displayIds.push(r.body.display.id);
      return { id: r.body.display.id as string, key: r.body.token as string, display: r.body.display };
    }
    const upstairs = await createDisplay("Upstairs");
    const breakArea = await createDisplay("Break Area TV");
    const tvState = async (key: string) => (await call("GET", `/api/greenhouse/display/${key}/state`)).body;
    const names = (state: any) => (state?.land?.phases ?? []).map((p: any) => p.name);
    const today = new Date().toISOString().slice(0, 10);
    const publish = (id: string, extra: Record<string, unknown>) =>
      call("PUT", `/api/greenhouse/displays/${id}`, token, { landId: landA, activityId: null, dateStart: today, dateEnd: today, rotationDegrees: 0, datePreset: "today", ...extra });

    // ---- Existing displays keep all phases ---------------------------------
    check(upstairs.display.phaseIds === null, "a display starts with phaseIds null (all phases)", upstairs.display);
    const initial = await tvState(upstairs.key);
    check(JSON.stringify(names(initial)) === JSON.stringify(["Phase 1", "Phase 2", "Phase 3"]), "TV shows every active phase when nothing is selected", names(initial));
    check(initial?.phaseIds === null, "TV state reports phaseIds null");

    // ---- Single phase ------------------------------------------------------
    const single = await publish(upstairs.id, { phaseIds: [p1] });
    check(single.status === 200 && JSON.stringify(single.body?.display?.phaseIds) === JSON.stringify([p1]), "publishing one phase saves it", single.body);
    const singleState = await tvState(upstairs.key);
    check(JSON.stringify(names(singleState)) === JSON.stringify(["Phase 1"]), "Upstairs TV shows only Phase 1", names(singleState));
    const blk = (singleState?.blocks ?? []).find((b: any) => b.id === blockId);
    check(blk?.totalRows === 1, "the block legend counts only rows in the shown phase (1 of its 2 rows)", singleState?.blocks);

    // ---- Multiple phases, per display --------------------------------------
    const multi = await publish(breakArea.id, { phaseIds: [p3, p2] });
    check(multi.status === 200 && [...multi.body.display.phaseIds].sort().join() === [p2, p3].sort().join(), "Break Area saves two phases", multi.body);
    check(JSON.stringify(names(await tvState(breakArea.key))) === JSON.stringify(["Phase 2", "Phase 3"]), "Break Area TV shows Phases 2 and 3 in sort order");
    check(JSON.stringify(names(await tvState(upstairs.key))) === JSON.stringify(["Phase 1"]), "Upstairs is unaffected (selection is per display)");

    // ---- Reload -------------------------------------------------------------
    const list = (await call("GET", "/api/greenhouse/displays", token)).body?.displays ?? [];
    const up = list.find((d: any) => d.id === upstairs.id);
    const br = list.find((d: any) => d.id === breakArea.id);
    check(JSON.stringify(up?.phaseIds) === JSON.stringify([p1]) && br?.phaseIds?.length === 2, "GET /displays returns each display's saved phases", { up: up?.phaseIds, br: br?.phaseIds });

    // ---- All phases ---------------------------------------------------------
    const allExplicit = await publish(breakArea.id, { phaseIds: [p1, p2, p3] });
    check(allExplicit.status === 200 && allExplicit.body?.display?.phaseIds === null, "checking every phase is stored as 'all' (null)", allExplicit.body?.display);
    check(names(await tvState(breakArea.key)).length === 3, "Break Area TV shows all three phases");
    const allNull = await publish(upstairs.id, { phaseIds: null });
    check(allNull.status === 200 && allNull.body?.display?.phaseIds === null, "phaseIds null publishes all phases");
    await publish(upstairs.id, { phaseIds: [p1] });

    // ---- Validation ---------------------------------------------------------
    const none = await publish(upstairs.id, { phaseIds: [] });
    check(none.status === 400 && /at least one phase/i.test(none.body?.error ?? ""), "an empty selection is rejected with a clear message", none.body);
    const otherLand = await publish(upstairs.id, { phaseIds: [q1] });
    check(otherLand.status === 400, "a phase from another land is rejected", otherLand.body);
    const inactive = await publish(upstairs.id, { phaseIds: [p4inactive] });
    check(inactive.status === 400, "an inactive phase is rejected", inactive.body);
    const garbage = await publish(upstairs.id, { phaseIds: ["nope"] });
    check(garbage.status === 400, "a malformed phase id is rejected", garbage.body);
    check(JSON.stringify(names(await tvState(upstairs.key))) === JSON.stringify(["Phase 1"]), "rejected publishes changed nothing");

    // ---- Older client (no phaseIds) and land change ------------------------
    const legacy = await call("PUT", `/api/greenhouse/displays/${upstairs.id}`, token, { landId: landA, activityId: null, dateStart: today, dateEnd: today, rotationDegrees: 90 });
    check(legacy.status === 200 && JSON.stringify(legacy.body?.display?.phaseIds) === JSON.stringify([p1]), "a publish without phaseIds keeps the selection", legacy.body?.display);
    check(legacy.body?.display?.rotationDegrees === 90, "rotation still publishes");
    const moved = await call("PUT", `/api/greenhouse/displays/${upstairs.id}`, token, { landId: landB, activityId: null, dateStart: today, dateEnd: today, rotationDegrees: 0 });
    check(moved.status === 200 && moved.body?.display?.phaseIds === null, "switching land without phaseIds resets to all phases", moved.body?.display);
    const movedBack = await publish(upstairs.id, { phaseIds: [p1], rotationDegrees: 180, datePreset: null, dateStart: "2026-10-01", dateEnd: "2026-10-03" });
    check(movedBack.status === 200, "setup: back on land A with Phase 1", movedBack.body);

    // ---- Other settings keep working ---------------------------------------
    const st = await tvState(upstairs.key);
    check(st?.rotationDegrees === 180 && st?.dateStart === "2026-10-01" && st?.dateEnd === "2026-10-03" && st?.datePreset === null, "TV state still carries rotation and fixed dates", st);
    const slides = await call("GET", `/api/greenhouse/display/${upstairs.key}/slides`);
    check(slides.status === 200 && Array.isArray(slides.body?.slides), "ranking slides endpoint still works", slides.status);
    const regen = await call("POST", `/api/greenhouse/displays/${upstairs.id}/regenerate-key`, token);
    const regenState = await call("GET", `/api/greenhouse/display/${regen.body?.token}/state`);
    check(regen.status === 200 && regenState.status === 200 && JSON.stringify(names(regenState.body)) === JSON.stringify(["Phase 1"]), "a regenerated TV link serves the same phase selection");

    // ---- Selected phase deactivated later: never a blank TV ----------------
    await pool.query(`update greenhouse_phases set is_active = false where id = $1`, [p1]);
    const fallback = (await call("GET", `/api/greenhouse/display/${regen.body?.token}/state`)).body;
    check(JSON.stringify(names(fallback)) === JSON.stringify(["Phase 2", "Phase 3"]) && fallback?.phaseIds === null, "when every selected phase is gone the TV falls back to all active phases", names(fallback));

    // ---- Office preview: block legend narrowed by phaseIds -----------------
    await pool.query(`update greenhouse_phases set is_active = true where id = $1`, [p1]);
    const preview = await call("GET", `/api/greenhouse/live?landId=${landA}&phaseIds=${p3}`, token);
    check(preview.status === 200 && preview.body?.land?.phases?.length === 3, "office preview still returns every phase (for the checkbox list)", preview.body?.land?.phases?.length);
    check((preview.body?.blocks ?? []).find((b: any) => b.id === blockId)?.totalRows === 1, "office preview legend counts only the previewed phases' rows", preview.body?.blocks);
  } finally {
    server.close();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from greenhouse_displays where id = any($1::uuid[])`, [displayIds]);
      if (blockId) {
        await client.query(`delete from employee_block_rows where block_id = $1`, [blockId]);
        await client.query(`delete from employee_blocks where id = $1`, [blockId]);
      }
      await client.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]);
      await client.query(`delete from greenhouse_phases where id = any($1::uuid[])`, [phaseIds]);
      await client.query(`delete from greenhouse_lands where id = any($1::uuid[])`, [landIds]);
      if (adminId) await client.query(`delete from employees where id = $1`, [adminId]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup failed:", err);
      fail++;
    } finally {
      client.release();
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
