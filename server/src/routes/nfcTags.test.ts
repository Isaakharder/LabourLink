// Integration tests for NFC tag <-> row/bin mapping (nfcTagResolution.ts,
// nfcTags.ts). Same convention as deviceAssignment.test.ts (itself hardened
// earlier in this same effort after the previous per-step cleanup pattern
// left orphaned QA fixtures in production): real router over real HTTP
// against the real database, disposable RUN_ID-suffixed QA fixtures, cleanup
// as one transaction with a final "nothing orphaned" assertion.
//
// Resolution preference (LabourLink UUID over hardware ID) is tested
// client-side (web/src/lib/nfcMappingCache.test.ts) since resolution itself
// happens entirely client-side against the cached GET /mappings list — this
// file covers the server's own responsibilities: serving that list, the
// register/write-mapping conflict + confirm flow (both directions), the
// admin-only gate, and the DB-level uniqueness the app logic relies on.
//
// Run with: npm run test:nfc-tags
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import nfcTagsRouter from "./nfcTags";

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
  app.use("/api/mobile/tags", nfcTagsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const BASE = `http://127.0.0.1:${port}`;

  async function call(
    method: string,
    path: string,
    deviceIdentifier: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceIdentifier },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
  const employeeIds: string[] = [];
  const deviceIds: string[] = [];
  const mappingIds: string[] = [];
  let landId!: string;
  let phaseId!: string;
  let rowAId!: string;
  let rowBId!: string;
  let carrierAId!: string;
  let carrierBId!: string;

  async function pairDevice(employeeId: string, label: string): Promise<string> {
    const identifier = randomUUID();
    const { rows } = await pool.query(
      `insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`,
      [identifier, `QA NFC Tags Device ${label} ${RUN_ID}`]
    );
    deviceIds.push(rows[0].id);
    await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [rows[0].id, employeeId]);
    return identifier;
  }

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) =>
      (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;

    async function createEmployee(label: string, role: string) {
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ($1, $2, $3, $4, $5, $6, true) returning id`,
        ["QA", `NFC Tags ${label} ${RUN_ID}`, `qa-nfc-tags-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return rows[0].id as string;
    }

    const adminId = await createEmployee("admin", "Administrator");
    const employeeId = await createEmployee("employee", "Employee");
    const adminDevice = await pairDevice(adminId, "admin");
    const employeeDevice = await pairDevice(employeeId, "employee");

    const land = await pool.query(
      `insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 100, 100) returning id`,
      [`QA NFC Tags Land ${RUN_ID}`]
    );
    landId = land.rows[0].id;
    const phase = await pool.query(
      `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 50, 50) returning id`,
      [landId, `QA NFC Tags Phase ${RUN_ID}`]
    );
    phaseId = phase.rows[0].id;
    const rowA = await pool.query(
      `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
       values ($1, 1, 0, 0, 4, 50, 'vertical') returning id`,
      [phaseId]
    );
    rowAId = rowA.rows[0].id;
    const rowB = await pool.query(
      `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
       values ($1, 2, 4, 0, 4, 50, 'vertical') returning id`,
      [phaseId]
    );
    rowBId = rowB.rows[0].id;

    const carrierA = await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [
      `QA NFC Tags Carrier A ${RUN_ID}`,
    ]);
    carrierAId = carrierA.rows[0].id;
    const carrierB = await pool.query(`insert into carriers (name, is_active) values ($1, true) returning id`, [
      `QA NFC Tags Carrier B ${RUN_ID}`,
    ]);
    carrierBId = carrierB.rows[0].id;

    // -----------------------------------------------------------------
    // A) admin-only gate: a non-admin device is rejected server-side,
    //    regardless of what the client would have shown.
    // -----------------------------------------------------------------
    const nonAdminAttempt = await call("POST", "/api/mobile/tags/register", employeeDevice, {
      targetType: "greenhouse_row",
      targetId: rowAId,
      ridderHardwareId: "048E7BE2202290",
    });
    check(nonAdminAttempt.status === 403, "A) non-admin device is rejected by requireDeviceAdmin", nonAdminAttempt);

    // -----------------------------------------------------------------
    // B) register an existing Ridder tag to row A — normalizes to
    //    uppercase hex, matching the real Ridder tag confirmed on-device
    //    (048e7be2202290 lowercase in the request, stored uppercase).
    // -----------------------------------------------------------------
    const register1 = await call("POST", "/api/mobile/tags/register", adminDevice, {
      targetType: "greenhouse_row",
      targetId: rowAId,
      ridderHardwareId: "048e7be2202290",
    });
    check(register1.status === 200 && Boolean(register1.body?.mappingId), "B) admin registers an existing tag to row A", register1);
    if (register1.body?.mappingId) mappingIds.push(register1.body.mappingId);

    const mappingsAfterB = await call("GET", "/api/mobile/tags/mappings", employeeDevice);
    const rowAMapping = mappingsAfterB.body?.mappings?.find((m: any) => m.targetId === rowAId);
    check(
      rowAMapping?.ridderHardwareId === "048E7BE2202290",
      "C) GET /mappings returns the hardware ID normalized to uppercase",
      rowAMapping
    );

    // -----------------------------------------------------------------
    // D) registering the SAME tag identifier to a DIFFERENT row (B)
    //    without confirmReplaceTag is rejected with the existing target
    //    named in the response — never silently moved.
    // -----------------------------------------------------------------
    const conflictAttempt = await call("POST", "/api/mobile/tags/register", adminDevice, {
      targetType: "greenhouse_row",
      targetId: rowBId,
      ridderHardwareId: "048E7BE2202290",
    });
    check(
      conflictAttempt.status === 409 && conflictAttempt.body?.tagConflict?.targetId === rowAId,
      "D) reusing an already-mapped tag on a different target is rejected without confirmReplaceTag",
      conflictAttempt
    );

    const confirmedMove = await call("POST", "/api/mobile/tags/register", adminDevice, {
      targetType: "greenhouse_row",
      targetId: rowBId,
      ridderHardwareId: "048E7BE2202290",
      confirmReplaceTag: true,
    });
    check(confirmedMove.status === 200, "E) confirming the move succeeds", confirmedMove);
    if (confirmedMove.body?.mappingId) mappingIds.push(confirmedMove.body.mappingId);

    const mappingsAfterMove = await call("GET", "/api/mobile/tags/mappings", employeeDevice);
    const stillOnRowA = mappingsAfterMove.body?.mappings?.some((m: any) => m.targetId === rowAId);
    const nowOnRowB = mappingsAfterMove.body?.mappings?.find((m: any) => m.targetId === rowBId);
    check(!stillOnRowA, "F) row A no longer has an active mapping after the tag moved to row B", mappingsAfterMove.body);
    check(nowOnRowB?.ridderHardwareId === "048E7BE2202290", "G) row B now has the moved tag", nowOnRowB);

    // -----------------------------------------------------------------
    // H) target-side conflict: writing a brand-new LabourLink tag to a
    //    carrier that already has a different active tag requires
    //    confirmReplaceTarget too (bidirectional reassignment
    //    confirmation, not just the tag-identifier side above).
    // -----------------------------------------------------------------
    const firstCarrierTag = await call("POST", "/api/mobile/tags/register", adminDevice, {
      targetType: "carrier",
      targetId: carrierAId,
      ridderHardwareId: "AABBCCDDEE",
    });
    check(firstCarrierTag.status === 200, "H) first tag registered to carrier A", firstCarrierTag);
    if (firstCarrierTag.body?.mappingId) mappingIds.push(firstCarrierTag.body.mappingId);

    const newLabourlinkUuid = randomUUID();
    const targetConflictAttempt = await call("POST", "/api/mobile/tags/write-mapping", adminDevice, {
      targetType: "carrier",
      targetId: carrierAId,
      labourlinkTagUuid: newLabourlinkUuid,
    });
    check(
      targetConflictAttempt.status === 409 && targetConflictAttempt.body?.targetConflict?.ridderHardwareId === "AABBCCDDEE",
      "I) mapping a new tag onto an already-tagged carrier is rejected without confirmReplaceTarget",
      targetConflictAttempt
    );

    const confirmedCarrierReplace = await call("POST", "/api/mobile/tags/write-mapping", adminDevice, {
      targetType: "carrier",
      targetId: carrierAId,
      labourlinkTagUuid: newLabourlinkUuid,
      confirmReplaceTarget: true,
    });
    check(confirmedCarrierReplace.status === 200, "J) confirming the carrier replacement succeeds", confirmedCarrierReplace);
    if (confirmedCarrierReplace.body?.mappingId) mappingIds.push(confirmedCarrierReplace.body.mappingId);

    // -----------------------------------------------------------------
    // K) direct DB check: the partial unique indexes reject a second
    //    active mapping for the same target even bypassing the app's own
    //    conflict logic entirely — the real guarantee behind "prevent one
    //    active tag mapping from belonging to multiple rows/bins".
    // -----------------------------------------------------------------
    let uniqueViolation = false;
    try {
      const r = await pool.query(
        `insert into nfc_tag_mappings (carrier_id, tag_kind, ridder_hardware_id, created_by_employee_id)
         values ($1, 'ridder', $2, $3) returning id`,
        [carrierAId, "112233445566", adminId]
      );
      mappingIds.push(r.rows[0].id);
    } catch (err: any) {
      uniqueViolation = err?.code === "23505";
    }
    check(uniqueViolation, "K) a direct second active mapping for the same carrier hits the unique index (23505)");

    // Untouched carrier B never got a mapping — GET /mappings must not
    // include it.
    const mappingsFinal = await call("GET", "/api/mobile/tags/mappings", employeeDevice);
    const carrierBPresent = mappingsFinal.body?.mappings?.some((m: any) => m.targetId === carrierBId);
    check(!carrierBPresent, "L) a target with no mapping never appears in GET /mappings", mappingsFinal.body);
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from nfc_tag_mappings where id = any($1::uuid[])`, [mappingIds]);
      // Belt-and-suspenders: also scope-delete by target, in case a step
      // above failed before its mapping id was captured.
      await client.query(`delete from nfc_tag_mappings where greenhouse_row_id = any($1::uuid[])`, [[rowAId, rowBId].filter(Boolean)]);
      await client.query(`delete from nfc_tag_mappings where carrier_id = any($1::uuid[])`, [
        [carrierAId, carrierBId].filter(Boolean),
      ]);
      if (rowAId || rowBId) await client.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [[rowAId, rowBId].filter(Boolean)]);
      if (phaseId) await client.query(`delete from greenhouse_phases where id = $1`, [phaseId]);
      if (landId) await client.query(`delete from greenhouse_lands where id = $1`, [landId]);
      if (carrierAId || carrierBId)
        await client.query(`delete from carriers where id = any($1::uuid[])`, [[carrierAId, carrierBId].filter(Boolean)]);
      await client.query(`delete from device_assignments where device_id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from devices where id = any($1::uuid[])`, [deviceIds]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }

    const leftoverEmployees = await pool.query(`select count(*) from employees where id = any($1::uuid[])`, [employeeIds]);
    const leftoverMappings = await pool.query(
      `select count(*) from nfc_tag_mappings where greenhouse_row_id = any($1::uuid[]) or carrier_id = any($2::uuid[])`,
      [[rowAId, rowBId].filter(Boolean), [carrierAId, carrierBId].filter(Boolean)]
    );
    check(
      Number(leftoverEmployees.rows[0].count) === 0 && Number(leftoverMappings.rows[0].count) === 0,
      "M) all QA fixtures cleaned up, none left orphaned"
    );

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
