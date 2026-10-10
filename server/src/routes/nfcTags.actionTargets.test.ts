import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import nfcTagsRouter from "./nfcTags";

// Activity and action tags (migration 062), tag removal (/unassign), retry
// idempotency for both registration routes, and compatibility with clients
// from before 062 (GET /mappings without ?include=all stays row/carrier-only).
// Requires a migrated LOCAL database; creates and removes its own fixtures.

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
const HEX = RUN_ID.toString(16).toUpperCase();

async function main() {
  const app = express();
  app.use(express.json());
  app.use("/api/mobile/tags", nfcTagsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, deviceIdentifier: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  let activityId: string | null = null;
  let rowId: string | null = null;
  let phaseId: string | null = null;
  let landId: string | null = null;

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    async function pairedDevice(label: string, role: string): Promise<string> {
      const emp = (
        await pool.query(
          `insert into employees (first_name, last_name, email, security_role_id, team_role_id, is_active)
           values ('QA', $1, $2, $3, $4, true) returning id`,
          [`NFC Actions ${label} ${RUN_ID}`, `qa-nfc-actions-${label}-${RUN_ID}@test.local`, await roleId(role), teamRoleId]
        )
      ).rows[0].id;
      employeeIds.push(emp);
      const identifier = randomUUID();
      const dev = (await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [identifier, `QA ${label}`])).rows[0].id;
      deviceIds.push(dev);
      await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [dev, emp]);
      return identifier;
    }
    const admin = await pairedDevice("admin", "Administrator");
    const employee = await pairedDevice("employee", "Employee");

    activityId = (await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [`QA Pruning ${RUN_ID}`])).rows[0].id;
    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`, [`QA Land ${RUN_ID}`])).rows[0].id;
    phaseId = (await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 50, 50) returning id`, [landId, `QA Phase ${RUN_ID}`])).rows[0].id;
    rowId = (
      await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, 1, 0, 0, 4, 50, 'vertical') returning id`,
        [phaseId]
      )
    ).rows[0].id;

    // Authorization: an employee device can read mappings but never change them.
    for (const path of ["/api/mobile/tags/register", "/api/mobile/tags/write-mapping", "/api/mobile/tags/unassign"]) {
      const r = await call("POST", path, employee, { targetType: "action", targetId: "start_break", ridderHardwareId: `EE${HEX}`, labourlinkTagUuid: randomUUID(), expectedTargetType: "action", expectedTargetId: "start_break" });
      check(r.status === 403, `employee device is refused on ${path}`, r);
    }
    check((await call("GET", "/api/mobile/tags/mappings?include=all", employee)).status === 200, "employee device can read mappings (needed to scan)");

    const targets = await call("GET", "/api/mobile/tags/activity-targets", admin);
    check(targets.status === 200 && targets.body.activities.some((x: any) => x.id === activityId), "admin can list every active activity for tag setup", targets.status);
    check((await call("GET", "/api/mobile/tags/activity-targets", employee)).status === 403, "employee device can't list activity targets");

    // Validation.
    const badAction = await call("POST", "/api/mobile/tags/register", admin, { targetType: "action", targetId: "start_work", ridderHardwareId: `AA${HEX}` });
    check(badAction.status === 400, "unknown action (start_work) is rejected", badAction);
    const badActivity = await call("POST", "/api/mobile/tags/register", admin, { targetType: "activity", targetId: randomUUID(), ridderHardwareId: `AA${HEX}` });
    check(badActivity.status === 400, "non-existent activity is rejected", badActivity);

    // Action tags: several tags per action; retry is idempotent.
    const breakTag1 = await call("POST", "/api/mobile/tags/register", admin, { targetType: "action", targetId: "start_break", ridderHardwareId: `B1${HEX}` });
    const breakTag2 = await call("POST", "/api/mobile/tags/register", admin, { targetType: "action", targetId: "start_break", ridderHardwareId: `b2${HEX.toLowerCase()}` });
    check(breakTag1.status === 200 && breakTag2.status === 200, "two different tags can both start a break", [breakTag1, breakTag2]);
    const breakRetry = await call("POST", "/api/mobile/tags/register", admin, { targetType: "action", targetId: "start_break", ridderHardwareId: `B1${HEX}` });
    check(breakRetry.status === 200 && breakRetry.body?.alreadyRegistered && breakRetry.body.mappingId === breakTag1.body.mappingId, "re-registering the same tag + action returns the existing mapping", breakRetry);

    // Activity tag written by the app (LabourLink tag ID).
    const pruningUuid = randomUUID();
    const pruning = await call("POST", "/api/mobile/tags/write-mapping", admin, { targetType: "activity", targetId: activityId, labourlinkTagUuid: pruningUuid });
    check(pruning.status === 200, "activity tag registered", pruning);
    const pruningRetry = await call("POST", "/api/mobile/tags/write-mapping", admin, { targetType: "activity", targetId: activityId, labourlinkTagUuid: pruningUuid });
    check(pruningRetry.body?.alreadyRegistered === true && pruningRetry.body.mappingId === pruning.body.mappingId, "activity write-mapping retry is idempotent", pruningRetry);
    const endWorkUuid = randomUUID();
    check((await call("POST", "/api/mobile/tags/write-mapping", admin, { targetType: "action", targetId: "end_work", labourlinkTagUuid: endWorkUuid })).status === 200, "end work tag registered");

    // A tag already assigned can't be silently reassigned.
    const reuse = await call("POST", "/api/mobile/tags/write-mapping", admin, { targetType: "action", targetId: "end_break", labourlinkTagUuid: pruningUuid });
    check(reuse.status === 409 && reuse.body?.code === "TAG_ID_IN_USE", "an activity tag can't be re-pointed at End Break", reuse);
    const hwReuse = await call("POST", "/api/mobile/tags/register", admin, { targetType: "greenhouse_row", targetId: rowId, ridderHardwareId: `B1${HEX}` });
    check(hwReuse.status === 409 && hwReuse.body?.code === "TAG_ASSIGNED_ELSEWHERE" && hwReuse.body?.tagConflict?.label === "Start Break", "a Start Break tag can't be silently moved to a row", hwReuse);

    // Old clients: default list is row/carrier only; new clients ask for all.
    const rowTag = await call("POST", "/api/mobile/tags/register", admin, { targetType: "greenhouse_row", targetId: rowId, ridderHardwareId: `C1${HEX}` });
    check(rowTag.status === 200, "row tag registered (legacy request shape)", rowTag);
    const rowRetry = await call("POST", "/api/mobile/tags/register", admin, { targetType: "greenhouse_row", targetId: rowId, ridderHardwareId: `C1${HEX}` });
    check(rowRetry.status === 200 && rowRetry.body?.alreadyRegistered, "legacy row registration retry is now idempotent (was a 409)", rowRetry);
    const legacy = (await call("GET", "/api/mobile/tags/mappings", employee)).body.mappings as any[];
    check(legacy.every((m) => m.targetType === "greenhouse_row" || m.targetType === "carrier"), "GET /mappings without include=all returns only row/carrier", legacy.map((m) => m.targetType));
    check(legacy.some((m) => m.ridderHardwareId === `C1${HEX}`), "the row tag is in the legacy list");
    const all = (await call("GET", "/api/mobile/tags/mappings?include=all", employee)).body.mappings as any[];
    const byHw = (hw: string) => all.find((m) => m.ridderHardwareId === hw);
    const byUuid = (u: string) => all.find((m) => m.labourlinkTagUuid === u);
    check(byHw(`B1${HEX}`)?.targetType === "action" && byHw(`B1${HEX}`)?.targetId === "start_break" && byHw(`B1${HEX}`)?.label === "Start Break", "include=all has the Start Break tag with its label", byHw(`B1${HEX}`));
    check(byHw(`B2${HEX}`)?.targetId === "start_break", "hardware IDs are normalized to uppercase");
    check(byUuid(pruningUuid)?.targetType === "activity" && byUuid(pruningUuid)?.label === `QA Pruning ${RUN_ID}`, "include=all has the activity tag labelled with the activity name", byUuid(pruningUuid));
    check(byUuid(endWorkUuid)?.label === "End Work", "End Work label");

    // Unassign (Clear Tag): guarded by the expected target, idempotent.
    const wrongTarget = await call("POST", "/api/mobile/tags/unassign", admin, { ridderHardwareId: `B1${HEX}`, expectedTargetType: "action", expectedTargetId: "end_break" });
    check(wrongTarget.status === 409 && wrongTarget.body?.code === "ASSIGNMENT_CHANGED", "unassign refuses when the tag now belongs to something else", wrongTarget);
    check(Boolean((await call("GET", "/api/mobile/tags/mappings?include=all", admin)).body.mappings.find((m: any) => m.ridderHardwareId === `B1${HEX}`)), "…and the assignment is still active");
    const removed = await call("POST", "/api/mobile/tags/unassign", admin, { ridderHardwareId: `b1${HEX.toLowerCase()}`, expectedTargetType: "action", expectedTargetId: "start_break" });
    check(removed.status === 200 && removed.body?.removed === true, "unassign removes the Start Break tag", removed);
    const removedAgain = await call("POST", "/api/mobile/tags/unassign", admin, { ridderHardwareId: `B1${HEX}`, expectedTargetType: "action", expectedTargetId: "start_break" });
    check(removedAgain.status === 200 && removedAgain.body?.alreadyRemoved === true, "unassign retry is idempotent", removedAgain);
    const removedActivity = await call("POST", "/api/mobile/tags/unassign", admin, { labourlinkTagUuid: pruningUuid.toUpperCase(), expectedTargetType: "activity", expectedTargetId: activityId });
    check(removedActivity.body?.removed === true, "activity tag removed by tag ID", removedActivity);
    const after = (await call("GET", "/api/mobile/tags/mappings?include=all", admin)).body.mappings as any[];
    check(!after.some((m) => m.ridderHardwareId === `B1${HEX}` || m.labourlinkTagUuid === pruningUuid), "removed tags are gone from the list");
    check(after.some((m) => m.ridderHardwareId === `B2${HEX}`), "the other Start Break tag is untouched");
    const reRegister = await call("POST", "/api/mobile/tags/register", admin, { targetType: "greenhouse_row", targetId: rowId, ridderHardwareId: `B1${HEX}`, confirmReplaceTarget: true });
    check(reRegister.status === 200, "a cleared tag can be assigned again", reRegister);

    // DB rule: exactly one target per mapping.
    let twoTargets = false;
    try {
      await pool.query(
        `insert into nfc_tag_mappings (activity_id, action, tag_kind, ridder_hardware_id, created_by_employee_id) values ($1, 'end_work', 'ridder', $2, $3)`,
        [activityId, `DD${HEX}`, employeeIds[0]]
      );
    } catch (err) {
      twoTargets = (err as { code?: string }).code === "23514";
    }
    check(twoTargets, "a mapping can't point at an activity and an action at once");
  } finally {
    server.close();
    await pool.query(`delete from nfc_tag_mappings where created_by_employee_id = any($1::uuid[]) or deactivated_by_employee_id = any($1::uuid[])`, [employeeIds]);
    if (rowId) await pool.query(`delete from greenhouse_rows where id = $1`, [rowId]);
    if (phaseId) await pool.query(`delete from greenhouse_phases where id = $1`, [phaseId]);
    if (landId) await pool.query(`delete from greenhouse_lands where id = $1`, [landId]);
    if (activityId) await pool.query(`delete from activities where id = $1`, [activityId]);
    await pool.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
    await pool.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
    await pool.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
