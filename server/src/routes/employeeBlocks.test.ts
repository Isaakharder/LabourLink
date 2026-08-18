// Covers the new Employee Block colour feature (soft colour-coding on the
// greenhouse live map): automatic least-used assignment on create,
// explicit preset selection persisting across reload, server-side
// rejection of any colour not on the fixed preset list, a Manager being
// able to change colour but nothing else, and the pre-existing "one row
// belongs to at most one block" reassignment behavior (employee_block_rows.
// greenhouse_row_id is itself the primary key — 022_employee_blocks.sql).
//
// Same real-HTTP-against-real-database convention as breakRounding.test.ts
// — no mocking.
//
// Run with: npm run test:employee-blocks
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { EMPLOYEE_BLOCK_COLOR_KEYS } from "../lib/employeeBlockColors";
import employeeBlocksRouter from "./employeeBlocks";

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
  app.use("/api/employee-blocks", employeeBlocksRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const blockIds: string[] = [];
  const employeeIds: string[] = [];
  const rowIds: string[] = [];
  let landId!: string;
  let phaseId!: string;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    const admin = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id, first_name, last_name`,
        [`EB Admin ${RUN_ID}`, `qa-eb-admin-${RUN_ID}@test.local`, await roleId("Administrator"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(admin.id);
    const adminToken = signSession({ id: admin.id, firstName: "QA", lastName: admin.last_name, securityRole: "Administrator", teamRole: "Team Member" });

    const manager = (
      await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id, first_name, last_name`,
        [`EB Manager ${RUN_ID}`, `qa-eb-manager-${RUN_ID}@test.local`, await roleId("Manager"), teamRoleId, fakePinHash]
      )
    ).rows[0];
    employeeIds.push(manager.id);
    const managerToken = signSession({ id: manager.id, firstName: "QA", lastName: manager.last_name, securityRole: "Manager", teamRole: "Team Member" });

    landId = (
      await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet, is_active) values ($1, 100, 100, true) returning id`, [
        `QA EB Land ${RUN_ID}`,
      ])
    ).rows[0].id;
    phaseId = (
      await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, is_active, sort_order) values ($1, $2, 50, 50, true, 1) returning id`,
        [landId, `QA EB Phase ${RUN_ID}`]
      )
    ).rows[0].id;
    async function insertRow(n: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, 0, 4, 20, 'horizontal') returning id`,
        [phaseId, n]
      );
      rowIds.push(rows[0].id);
      return rows[0].id;
    }

    // -----------------------------------------------------------------
    // 1) Creating a block WITHOUT an explicit colour auto-assigns one from
    //    the fixed preset list.
    // -----------------------------------------------------------------
    let firstBlockId!: string;
    {
      const res = await call("POST", "/api/employee-blocks", {
        token: adminToken,
        body: { name: `QA EB Block A ${RUN_ID}` },
      });
      check(res.status === 201, "1) creating a block with no colorKey succeeds", res.body);
      firstBlockId = res.body.block.id;
      blockIds.push(firstBlockId);
      check(
        (EMPLOYEE_BLOCK_COLOR_KEYS as readonly string[]).includes(res.body.block.colorKey),
        "1) the created block was auto-assigned one of the fixed preset colours",
        res.body.block.colorKey
      );
    }

    // -----------------------------------------------------------------
    // 1b) A second block, also auto-assigned, prefers a colour not already
    //     heavily used — since only one colour is in use so far, it must
    //     pick a DIFFERENT one (least-used, ties broken by palette order).
    // -----------------------------------------------------------------
    {
      const res = await call("POST", "/api/employee-blocks", {
        token: adminToken,
        body: { name: `QA EB Block B ${RUN_ID}` },
      });
      blockIds.push(res.body.block.id);
      check(
        res.body.block.colorKey !== undefined && res.body.block.colorKey !== null,
        "1b) the second auto-assigned block also got a valid colour",
        res.body.block.colorKey
      );
    }

    // -----------------------------------------------------------------
    // 2) Selecting a different preset persists after reload (PATCH, then
    //    a fresh GET).
    // -----------------------------------------------------------------
    {
      const newColor = "mutedAmber";
      const patchRes = await call("PATCH", `/api/employee-blocks/${firstBlockId}`, {
        token: adminToken,
        body: { colorKey: newColor },
      });
      check(patchRes.status === 200 && patchRes.body.block.colorKey === newColor, "2) PATCH with a valid preset succeeds", patchRes.body);

      const reloadRes = await call("GET", `/api/employee-blocks/${firstBlockId}`, { token: adminToken });
      check(reloadRes.body?.block?.colorKey === newColor, "2) the new colour persists across a fresh GET (reload)", reloadRes.body);

      const listRes = await call("GET", "/api/employee-blocks", { token: adminToken });
      const inList = listRes.body?.blocks?.find((b: any) => b.id === firstBlockId);
      check(inList?.colorKey === newColor, "2) the new colour also shows up in the plain list endpoint", inList);
    }

    // -----------------------------------------------------------------
    // 3) Invalid/arbitrary colours are rejected server-side — both on
    //    create and on update. Never stored as raw CSS.
    // -----------------------------------------------------------------
    {
      const createRes = await call("POST", "/api/employee-blocks", {
        token: adminToken,
        body: { name: `QA EB Invalid Create ${RUN_ID}`, colorKey: "hotpink" },
      });
      check(createRes.status === 400 && createRes.body?.errors?.colorKey, "3) POST with an arbitrary colour is rejected (400)", createRes.body);

      const cssInjection = await call("POST", "/api/employee-blocks", {
        token: adminToken,
        body: { name: `QA EB Invalid CSS ${RUN_ID}`, colorKey: "#ff00ff" },
      });
      check(cssInjection.status === 400, "3) POST with raw CSS (a hex value) is rejected (400)", cssInjection.body);

      const patchRes = await call("PATCH", `/api/employee-blocks/${firstBlockId}`, {
        token: adminToken,
        body: { colorKey: "neonGreen" },
      });
      check(patchRes.status === 400 && patchRes.body?.errors?.colorKey, "3) PATCH with an arbitrary colour is rejected (400)", patchRes.body);

      // Confirm the earlier valid PATCH from scenario 2 wasn't clobbered by
      // this rejected request.
      const after = await call("GET", `/api/employee-blocks/${firstBlockId}`, { token: adminToken });
      check(after.body?.block?.colorKey === "mutedAmber", "3) the block's colour is unchanged after the rejected PATCH", after.body);
    }

    // -----------------------------------------------------------------
    // A Manager may change a block's colour but nothing else — the task's
    // explicit "Allow an Administrator/Manager to select another preset."
    // -----------------------------------------------------------------
    {
      const colorOnly = await call("PATCH", `/api/employee-blocks/${firstBlockId}`, {
        token: managerToken,
        body: { colorKey: "blueGrey" },
      });
      check(colorOnly.status === 200 && colorOnly.body.block.colorKey === "blueGrey", "Manager can change a block's colour", colorOnly.body);

      const nameAttempt = await call("PATCH", `/api/employee-blocks/${firstBlockId}`, {
        token: managerToken,
        body: { name: "Manager Renamed This" },
      });
      check(nameAttempt.status === 403, "Manager cannot rename a block (403)", nameAttempt.body);

      const mixedAttempt = await call("PATCH", `/api/employee-blocks/${firstBlockId}`, {
        token: managerToken,
        body: { colorKey: "softPlum", employeeId: null },
      });
      check(mixedAttempt.status === 403, "Manager cannot reassign the employee even alongside a valid colour change (403)", mixedAttempt.body);

      const stillBlueGrey = await call("GET", `/api/employee-blocks/${firstBlockId}`, { token: adminToken });
      check(
        stillBlueGrey.body?.block?.colorKey === "blueGrey" && stillBlueGrey.body?.block?.name === `QA EB Block A ${RUN_ID}`,
        "Manager's rejected requests changed nothing — colour stays from the last successful PATCH, name unchanged",
        stillBlueGrey.body
      );

      const createAttempt = await call("POST", "/api/employee-blocks", {
        token: managerToken,
        body: { name: "Manager Created This" },
      });
      check(createAttempt.status === 403, "Manager still cannot create a new block (403, unchanged Administrator-only rule)", createAttempt.body);
    }

    // -----------------------------------------------------------------
    // 13) One physical row belongs to at most one block at a time — the
    //     existing PUT .../rows reassignment behavior, still correct with
    //     colour now in play: linking a row to block B removes it from
    //     block A rather than creating any overlap.
    // -----------------------------------------------------------------
    {
      const rowX = await insertRow(501);
      const blockA = firstBlockId; // already exists
      const blockBRes = await call("POST", "/api/employee-blocks", { token: adminToken, body: { name: `QA EB Block C ${RUN_ID}` } });
      const blockB = blockBRes.body.block.id;
      blockIds.push(blockB);

      await call("PUT", `/api/employee-blocks/${blockA}/rows`, { token: adminToken, body: { rowIds: [rowX] } });
      const afterA = await call("GET", `/api/employee-blocks/${blockA}`, { token: adminToken });
      check(afterA.body?.block?.rows?.some((r: any) => r.id === rowX), "13) row X is linked to block A", afterA.body);

      await call("PUT", `/api/employee-blocks/${blockB}/rows`, { token: adminToken, body: { rowIds: [rowX] } });
      const afterAReassigned = await call("GET", `/api/employee-blocks/${blockA}`, { token: adminToken });
      const afterB = await call("GET", `/api/employee-blocks/${blockB}`, { token: adminToken });
      check(
        !afterAReassigned.body?.block?.rows?.some((r: any) => r.id === rowX),
        "13) row X is no longer linked to block A after being linked to block B — never overlapping",
        afterAReassigned.body
      );
      check(afterB.body?.block?.rows?.some((r: any) => r.id === rowX), "13) row X is now linked to block B", afterB.body);

      const { rows: dbCheck } = await pool.query(`select block_id from employee_block_rows where greenhouse_row_id = $1`, [rowX]);
      check(dbCheck.length === 1 && dbCheck[0].block_id === blockB, "13) the database itself has exactly one (row, block) link — schema-enforced, not just app logic", dbCheck);
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (blockIds.length) await tryDelete("employee_blocks", () => pool.query(`delete from employee_blocks where id = any($1::uuid[])`, [blockIds]));
    if (rowIds.length) await tryDelete("greenhouse_rows", () => pool.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]));
    if (phaseId) await tryDelete("greenhouse_phases", () => pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]));
    if (landId) await tryDelete("greenhouse_lands", () => pool.query(`delete from greenhouse_lands where id = $1`, [landId]));
    if (employeeIds.length) await tryDelete("employees", () => pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]));
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
