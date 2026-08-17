// Integration tests for the greenhouse row-restore fix: deleting a single
// row from the middle of a saved batch, then trying to add that same row
// number back, used to fail with "would fall outside the phase boundary" —
// even though the deleted row's own number and slot are supposed to be
// free again. Root cause: the placement engine's "continue after existing"
// math (computeContinuationOffset in lib/rowLayout.ts) can only ever
// resolve to "just past the deepest row currently surviving in the lane,"
// never to a specific row_number's own historical mid-sequence slot — so
// re-adding row 85 through the normal batch-generation flow always tried
// to append it after the LAST row in the phase, not back into its own gap.
//
// The fix (POST /rows/:id/restore in greenhouseLayout.ts) never re-derives
// geometry through the placement engine at all: a deleted row's own
// x/y/width/length/orientation are never touched by DELETE /rows/:id, so
// restoring is just clearing deleted_at on that exact same database
// record — guaranteed to reproduce its original position, and impossible
// to accidentally append after the wrong row.
//
// Same real-HTTP-against-real-database convention as
// greenhouseDisplays.test.ts / mobileTime.switchWarnings.test.ts — no
// mocking, real Postgres, RUN_ID-suffixed disposable fixtures, cleanup in a
// `finally` block.
//
// Run with: npm run test:greenhouse-row-restore
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import greenhouseLayoutRouter from "./greenhouseLayout";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowGeom(row: any) {
  return { xFt: row.xFt, yFt: row.yFt, widthFt: row.widthFt, lengthFt: row.lengthFt, orientation: row.orientation };
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/greenhouse-layout", greenhouseLayoutRouter);
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
    opts: { token?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Cookie: `labourlink_session=${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  const adminToken = signSession({
    id: randomUUID(),
    firstName: "QA",
    lastName: `Row Restore Admin ${RUN_ID}`,
    securityRole: "Administrator",
    teamRole: "Team Member",
  });

  let landId!: string;
  const phaseIds: string[] = [];

  try {
    landId = (
      await pool.query(
        `insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 300) returning id`,
        [`QA Row Restore Land ${RUN_ID}`]
      )
    ).rows[0].id;

    async function createPhase(northSouthFeet: number, eastWestFeet: number): Promise<string> {
      const { rows } = await pool.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, $3, $4) returning id`,
        [landId, `QA Row Restore Phase ${RUN_ID}-${phaseIds.length}`, northSouthFeet, eastWestFeet]
      );
      phaseIds.push(rows[0].id);
      return rows[0].id;
    }

    // =====================================================================
    // Regression tests 1, 2, 6, 7: a saved batch of 10 rows plus a second,
    // unrelated batch in a different lane of the same phase; delete row 5
    // from the middle of the first batch, then restore it.
    // =====================================================================
    {
      const phaseId = await createPhase(100, 50);

      const batchARes = await call("POST", `/api/greenhouse-layout/phases/${phaseId}/row-batches`, {
        token: adminToken,
        body: {
          name: "QA Main Batch",
          startSide: "south",
          anchorSide: "west",
          rowWidthFt: 2,
          rowLengthFt: 20,
          rowGapFt: 1,
          startOffsetFt: 0,
          anchorOffsetFt: 0,
          numberingMode: "all",
          startRowNumber: 1,
          endRowNumber: 10,
        },
      });
      check(
        batchARes.status === 201 && batchARes.body?.rows?.length === 10,
        "setup: a 10-row saved south/west batch is created",
        batchARes.body
      );
      const batchAId = batchARes.body.batch.id;
      const rowsA: any[] = batchARes.body.rows;
      const row5Before = rowsA.find((r) => r.rowNumber === 5);
      const row4Before = rowsA.find((r) => r.rowNumber === 4);
      const row6Before = rowsA.find((r) => r.rowNumber === 6);

      // A second, unrelated batch in a different (perpendicular) lane of
      // the same phase — must be completely untouched by anything below.
      const batchBRes = await call("POST", `/api/greenhouse-layout/phases/${phaseId}/row-batches`, {
        token: adminToken,
        body: {
          name: "QA Unrelated Batch",
          startSide: "north",
          anchorSide: "east",
          rowWidthFt: 3,
          rowLengthFt: 15,
          rowGapFt: 2,
          startOffsetFt: 5,
          anchorOffsetFt: 0,
          numberingMode: "all",
          startRowNumber: 101,
          endRowNumber: 105,
        },
      });
      check(
        batchBRes.status === 201 && batchBRes.body?.rows?.length === 5,
        "setup: an unrelated 5-row north/east batch is created in the same phase",
        batchBRes.body
      );
      const rowsBBefore: any[] = batchBRes.body.rows;

      // ---- 1) delete row 5 from the middle, then restore it -------------
      const delRes = await call("DELETE", `/api/greenhouse-layout/rows/${row5Before.id}`, { token: adminToken });
      check(delRes.status === 200, "1) deleting row 5 from the middle of the batch succeeds", delRes.body);

      const afterDelete = await call("GET", `/api/greenhouse-layout/phases/${phaseId}/rows`, { token: adminToken });
      check(
        afterDelete.body?.rows?.length === 14 && !afterDelete.body.rows.some((r: any) => r.rowNumber === 5),
        "1) after deletion, row 5 is gone from the active list (10+5-1=14 remain)",
        afterDelete.body?.rows?.map((r: any) => r.rowNumber)
      );

      const restoreRes = await call("POST", `/api/greenhouse-layout/rows/${row5Before.id}/restore`, {
        token: adminToken,
      });
      check(restoreRes.status === 200, "1) restoring row 5 (previously deleted) succeeds", restoreRes.body);

      // ---- 2) the restored row uses its original location/geometry ------
      check(
        JSON.stringify(rowGeom(restoreRes.body.row)) === JSON.stringify(rowGeom(row5Before)) &&
          restoreRes.body.row.rowNumber === 5,
        "2) the restored row's geometry is byte-identical to its original, pre-deletion geometry",
        { before: row5Before, after: restoreRes.body.row }
      );
      check(
        restoreRes.body.row.id === row5Before.id && restoreRes.body.row.rowBatchId === batchAId,
        "2) restore reuses the SAME database record and its original batch — never a new row or batch",
        restoreRes.body.row
      );

      // ---- 6) neighbouring rows and the unrelated batch are untouched ---
      const afterRestore = await call("GET", `/api/greenhouse-layout/phases/${phaseId}/rows`, { token: adminToken });
      const row4After = afterRestore.body.rows.find((r: any) => r.rowNumber === 4);
      const row6After = afterRestore.body.rows.find((r: any) => r.rowNumber === 6);
      check(
        JSON.stringify(rowGeom(row4After)) === JSON.stringify(rowGeom(row4Before)) &&
          JSON.stringify(rowGeom(row6After)) === JSON.stringify(rowGeom(row6Before)),
        "6) restoring row 5 did not move, resize, or recreate its immediate neighbours (rows 4 and 6)",
        { row4Before, row4After, row6Before, row6After }
      );
      const rowsBAfter = afterRestore.body.rows
        .filter((r: any) => r.rowNumber >= 101 && r.rowNumber <= 105)
        .sort((a: any, b: any) => a.rowNumber - b.rowNumber);
      check(
        JSON.stringify(rowsBAfter.map(rowGeom)) === JSON.stringify(rowsBBefore.map(rowGeom)),
        "6) restoring row 5 left the unrelated batch's saved geometry completely unmodified",
        { rowsBBefore, rowsBAfter }
      );
      check(afterRestore.body.rows.length === 15, "6) exactly 15 active rows exist (10 + 5) — no extras", afterRestore.body.rows.length);

      // ---- 7) no duplicate database records exist after restoration ----
      const { rows: row5Records } = await pool.query(
        `select id, deleted_at from greenhouse_rows where phase_id = $1 and row_number = 5`,
        [phaseId]
      );
      check(
        row5Records.length === 1 && row5Records[0].id === row5Before.id && row5Records[0].deleted_at === null,
        "7) exactly one greenhouse_rows record exists for row 5 (the original, now active) — no duplicate was inserted",
        row5Records
      );
    }

    // =====================================================================
    // 3) & 4): deleted rows are excluded from active collision/duplicate
    // checks, but an existing ACTIVE row number is still protected — both
    // through the normal add-batch endpoint and through restore.
    // =====================================================================
    {
      const northSouthFeet = 100;
      const rowWidthFt = 2;
      const phaseId = await createPhase(northSouthFeet, 50);
      const batchRes = await call("POST", `/api/greenhouse-layout/phases/${phaseId}/row-batches`, {
        token: adminToken,
        body: {
          name: "QA Dup Batch",
          startSide: "south",
          anchorSide: "west",
          rowWidthFt,
          rowLengthFt: 20,
          rowGapFt: 1,
          startOffsetFt: 0,
          anchorOffsetFt: 0,
          numberingMode: "all",
          startRowNumber: 1,
          endRowNumber: 10,
        },
      });
      const row8Original = batchRes.body.rows.find((r: any) => r.rowNumber === 8);

      const delRes = await call("DELETE", `/api/greenhouse-layout/rows/${row8Original.id}`, { token: adminToken });
      check(delRes.status === 200, "setup: row 8 deleted", delRes.body);

      // 3) A brand-new row 8, placed in the EXACT same physical footprint
      // the deleted row 8 used to occupy, must succeed — the duplicate
      // row-number check and the spatial overlap check must both ignore a
      // deleted row.
      const startOffsetFt = northSouthFeet - rowWidthFt - row8Original.yFt;
      const newRow8Res = await call("POST", `/api/greenhouse-layout/phases/${phaseId}/row-batches`, {
        token: adminToken,
        body: {
          name: "QA New Row 8",
          startSide: "south",
          anchorSide: "west",
          rowWidthFt,
          rowLengthFt: 20,
          rowGapFt: 1,
          startOffsetFt,
          anchorOffsetFt: 0,
          numberingMode: "all",
          startRowNumber: 8,
          endRowNumber: 8,
        },
      });
      check(
        newRow8Res.status === 201 &&
          Math.abs(newRow8Res.body?.rows?.[0]?.yFt - row8Original.yFt) < 0.01 &&
          Math.abs(newRow8Res.body?.rows?.[0]?.xFt - row8Original.xFt) < 0.01,
        "3) a brand-new active row 8 can be created in the exact footprint the deleted row 8 used to occupy",
        newRow8Res.body
      );
      const newRow8Id = newRow8Res.body.rows[0].id;

      // 4) Now that row 8 is active again (as a NEW record), the number is
      // genuinely taken: another add attempt is rejected, and restoring the
      // ORIGINAL deleted row 8 is also rejected.
      const dupAddRes = await call("POST", `/api/greenhouse-layout/phases/${phaseId}/row-batches`, {
        token: adminToken,
        body: {
          name: "QA Duplicate Attempt",
          startSide: "north",
          anchorSide: "east",
          rowWidthFt: 2,
          rowLengthFt: 10,
          rowGapFt: 1,
          startOffsetFt: 0,
          anchorOffsetFt: 0,
          numberingMode: "all",
          startRowNumber: 8,
          endRowNumber: 8,
        },
      });
      check(
        dupAddRes.status === 409 && /already exist/i.test(dupAddRes.body?.error ?? ""),
        "4) adding another row 8 while one is already active is still rejected",
        dupAddRes.body
      );

      const restoreOriginalRes = await call("POST", `/api/greenhouse-layout/rows/${row8Original.id}/restore`, {
        token: adminToken,
      });
      check(
        restoreOriginalRes.status === 409 && /already in use/i.test(restoreOriginalRes.body?.error ?? ""),
        "4) restoring the original deleted row 8 is rejected while another active row 8 exists",
        restoreOriginalRes.body
      );

      // The originally-deleted row 8 stays deleted; only ONE active row 8
      // exists (the new one) — restore never silently duplicated or
      // resurrected the old record.
      const { rows: row8Records } = await pool.query(
        `select id, deleted_at from greenhouse_rows where phase_id = $1 and row_number = 8`,
        [phaseId]
      );
      const activeRow8s = row8Records.filter((r) => r.deleted_at === null);
      check(
        row8Records.length === 2 && activeRow8s.length === 1 && activeRow8s[0].id === newRow8Id,
        "7) exactly one ACTIVE row 8 record exists; the old deleted one was never resurrected or duplicated",
        row8Records
      );
    }

    // =====================================================================
    // 5) Genuine out-of-bounds is still rejected — both for a fresh add
    // and for a restore whose original slot no longer fits after a shrink.
    // =====================================================================
    {
      // 5a) A fresh add-batch request that plainly doesn't fit.
      const phaseId = await createPhase(20, 20);
      const oobRes = await call("POST", `/api/greenhouse-layout/phases/${phaseId}/row-batches`, {
        token: adminToken,
        body: {
          name: "QA Out Of Bounds",
          startSide: "south",
          anchorSide: "west",
          rowWidthFt: 5,
          rowLengthFt: 500,
          rowGapFt: 0,
          startOffsetFt: 0,
          anchorOffsetFt: 0,
          numberingMode: "all",
          startRowNumber: 1,
          endRowNumber: 1,
        },
      });
      check(
        oobRes.status === 422 && /outside the phase boundary/i.test(oobRes.body?.error ?? ""),
        "5) a genuinely out-of-bounds new row is still rejected",
        oobRes.body
      );

      // 5b) A deleted row whose original slot no longer fits after the
      // phase itself is later shrunk must also be rejected on restore —
      // proves the fix didn't weaken boundary validation for restore
      // either.
      const shrinkPhaseId = await createPhase(50, 50);
      const shrinkBatchRes = await call("POST", `/api/greenhouse-layout/phases/${shrinkPhaseId}/row-batches`, {
        token: adminToken,
        body: {
          name: "QA Shrink Batch",
          startSide: "north",
          anchorSide: "west",
          rowWidthFt: 2,
          rowLengthFt: 20,
          rowGapFt: 1,
          startOffsetFt: 0,
          anchorOffsetFt: 0,
          numberingMode: "all",
          startRowNumber: 1,
          endRowNumber: 5,
        },
      });
      const rowsShrink: any[] = shrinkBatchRes.body.rows;
      // North start: row 5 (highest number) sits deepest from the north
      // edge (highest yFt) — the row most sensitive to a shrink.
      const deepestRow = rowsShrink.reduce((a: any, b: any) => (a.yFt > b.yFt ? a : b));
      const shallowerMax = Math.max(
        ...rowsShrink.filter((r: any) => r.id !== deepestRow.id).map((r: any) => r.yFt + r.widthFt)
      );

      const delDeepRes = await call("DELETE", `/api/greenhouse-layout/rows/${deepestRow.id}`, { token: adminToken });
      check(delDeepRes.status === 200, "5b) setup: the deepest row is deleted", delDeepRes.body);

      // Shrink to a size that still comfortably fits every remaining
      // active row but is smaller than the deleted row's own far edge.
      const newNorthSouthFeet = Math.ceil(shallowerMax) + 1;
      check(
        newNorthSouthFeet < deepestRow.yFt + deepestRow.widthFt,
        "5b) setup: the chosen shrink size fits every surviving active row but not the deleted row's old slot",
        { newNorthSouthFeet, deepestRow }
      );
      const shrinkRes = await call("PATCH", `/api/greenhouse-layout/phases/${shrinkPhaseId}`, {
        token: adminToken,
        body: { northSouthFeet: newNorthSouthFeet },
      });
      check(
        shrinkRes.status === 200,
        "5b) setup: the phase is shrunk (every surviving active row still fits, so this is allowed)",
        shrinkRes.body
      );

      const restoreDeepRes = await call("POST", `/api/greenhouse-layout/rows/${deepestRow.id}/restore`, {
        token: adminToken,
      });
      check(
        restoreDeepRes.status === 422 && /boundary|no longer fits/i.test(restoreDeepRes.body?.error ?? ""),
        "5b) restoring a row whose original slot no longer fits the (since-shrunk) phase is still rejected",
        restoreDeepRes.body
      );
    }
  } finally {
    async function tryDelete(label: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`cleanup step failed (${label}):`, err);
      }
    }

    if (phaseIds.length) {
      await tryDelete("greenhouse_rows", () =>
        pool.query(`delete from greenhouse_rows where phase_id = any($1::uuid[])`, [phaseIds])
      );
      await tryDelete("greenhouse_row_batches", () =>
        pool.query(`delete from greenhouse_row_batches where phase_id = any($1::uuid[])`, [phaseIds])
      );
      await tryDelete("greenhouse_phases", () =>
        pool.query(`delete from greenhouse_phases where id = any($1::uuid[])`, [phaseIds])
      );
    }
    if (landId) {
      await tryDelete("greenhouse_lands", () => pool.query("delete from greenhouse_lands where id = $1", [landId]));
    }
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
