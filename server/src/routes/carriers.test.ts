// Integration tests for Basic Data > Carriers (routes/carriers.ts): single
// create/edit with tare weight, bulk create, duplicate skipping, invalid
// ranges, and invalid tare weight. Same convention as
// inputs.manualEntries.test.ts: real router over real HTTP against the real
// database (no test-DB harness exists in this repo), disposable
// RUN_ID-suffixed QA fixtures, cleanup in a `finally` block regardless of
// pass/fail. requireAuth only verifies the JWT signature (no DB lookup), so
// unlike inputs.manualEntries.test.ts no real employee row is needed for
// the session tokens below.
//
// Run with: npm run test:carriers
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import carriersRouter from "./carriers";

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
const NAME_PREFIX = `QA Carrier ${RUN_ID}`;
const BULK_PREFIX = `QABin${RUN_ID}`;

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/carriers", carriersRouter);
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
    lastName: `Carriers Admin ${RUN_ID}`,
    securityRole: "Administrator",
    teamRole: "Team Member",
  });
  const managerToken = signSession({
    id: randomUUID(),
    firstName: "QA",
    lastName: `Carriers Manager ${RUN_ID}`,
    securityRole: "Manager",
    teamRole: "Team Member",
  });

  const carrierIds: string[] = [];

  try {
    // -----------------------------------------------------------------
    // A) single create requires tareWeightKg and rejects a negative value.
    // -----------------------------------------------------------------
    const missingTare = await call("POST", "/api/carriers", {
      token: adminToken,
      body: { name: `${NAME_PREFIX} Missing Tare` },
    });
    check(
      missingTare.status === 400 && Boolean(missingTare.body?.errors?.tareWeightKg),
      "A) create without tareWeightKg is rejected",
      missingTare
    );

    const negativeTare = await call("POST", "/api/carriers", {
      token: adminToken,
      body: { name: `${NAME_PREFIX} Negative Tare`, tareWeightKg: -5 },
    });
    check(
      negativeTare.status === 400 && Boolean(negativeTare.body?.errors?.tareWeightKg),
      "B) create with a negative tareWeightKg is rejected",
      negativeTare
    );

    // -----------------------------------------------------------------
    // C) single create with a valid decimal tare weight succeeds and is
    //    returned/stored exactly.
    // -----------------------------------------------------------------
    const created = await call("POST", "/api/carriers", {
      token: adminToken,
      body: { name: `${NAME_PREFIX} A`, tareWeightKg: 27.5, notes: "QA note" },
    });
    check(created.status === 201 && created.body?.carrier?.tareWeightKg === 27.5, "C) create with a decimal tareWeightKg succeeds", created);
    if (created.body?.carrier?.id) carrierIds.push(created.body.carrier.id);
    const carrierAId = created.body?.carrier?.id as string;

    // -----------------------------------------------------------------
    // D) editing tareWeightKg is validated the same way as create, and a
    //    valid edit persists.
    // -----------------------------------------------------------------
    const editNegative = await call("PATCH", `/api/carriers/${carrierAId}`, {
      token: adminToken,
      body: { tareWeightKg: -1 },
    });
    check(editNegative.status === 400 && Boolean(editNegative.body?.errors?.tareWeightKg), "D) edit with a negative tareWeightKg is rejected", editNegative);

    const editValid = await call("PATCH", `/api/carriers/${carrierAId}`, {
      token: adminToken,
      body: { tareWeightKg: 30 },
    });
    check(editValid.status === 200 && editValid.body?.carrier?.tareWeightKg === 30, "E) edit with a valid tareWeightKg persists", editValid);

    const getAfterEdit = await call("GET", `/api/carriers/${carrierAId}`, { token: adminToken });
    check(getAfterEdit.body?.carrier?.tareWeightKg === 30, "F) GET reflects the edited tareWeightKg", getAfterEdit.body);

    // -----------------------------------------------------------------
    // G) existing active/inactive filtering still works alongside the new
    //    column.
    // -----------------------------------------------------------------
    await call("PATCH", `/api/carriers/${carrierAId}`, { token: adminToken, body: { isActive: false } });
    const activeList = await call("GET", `/api/carriers?status=active&search=${encodeURIComponent(NAME_PREFIX)}`, { token: adminToken });
    const inactiveList = await call("GET", `/api/carriers?status=inactive&search=${encodeURIComponent(NAME_PREFIX)}`, { token: adminToken });
    check(
      !activeList.body?.carriers?.some((c: any) => c.id === carrierAId) &&
        inactiveList.body?.carriers?.some((c: any) => c.id === carrierAId),
      "G) status=active/inactive filtering still excludes/includes correctly",
      { activeList: activeList.body, inactiveList: inactiveList.body }
    );
    await call("PATCH", `/api/carriers/${carrierAId}`, { token: adminToken, body: { isActive: true } });

    // -----------------------------------------------------------------
    // H) bulk create is admin-only, same gate as single create.
    // -----------------------------------------------------------------
    const bulkNonAdmin = await call("POST", "/api/carriers/bulk", {
      token: managerToken,
      body: { prefix: BULK_PREFIX, startNumber: 1, endNumber: 3, tareWeightKg: 0 },
    });
    check(bulkNonAdmin.status === 403, "H) bulk create rejects a non-Administrator role", bulkNonAdmin);

    // -----------------------------------------------------------------
    // I) invalid ranges are rejected with field errors, before touching
    //    the database.
    // -----------------------------------------------------------------
    const badRange = await call("POST", "/api/carriers/bulk", {
      token: adminToken,
      body: { prefix: BULK_PREFIX, startNumber: 10, endNumber: 5, tareWeightKg: 0 },
    });
    check(badRange.status === 400 && Boolean(badRange.body?.errors?.endNumber), "I) bulk create rejects endNumber < startNumber", badRange);

    const tooLarge = await call("POST", "/api/carriers/bulk", {
      token: adminToken,
      body: { prefix: BULK_PREFIX, startNumber: 1, endNumber: 5000, tareWeightKg: 0 },
    });
    check(tooLarge.status === 400 && Boolean(tooLarge.body?.errors?.endNumber), "J) bulk create rejects a range over the batch cap", tooLarge);

    const emptyPrefix = await call("POST", "/api/carriers/bulk", {
      token: adminToken,
      body: { prefix: "  ", startNumber: 1, endNumber: 5, tareWeightKg: 0 },
    });
    check(emptyPrefix.status === 400 && Boolean(emptyPrefix.body?.errors?.prefix), "K) bulk create rejects a blank prefix", emptyPrefix);

    const badTare = await call("POST", "/api/carriers/bulk", {
      token: adminToken,
      body: { prefix: BULK_PREFIX, startNumber: 1, endNumber: 5, tareWeightKg: -2 },
    });
    check(badTare.status === 400 && Boolean(badTare.body?.errors?.tareWeightKg), "L) bulk create rejects a negative tareWeightKg", badTare);

    // -----------------------------------------------------------------
    // M) a valid bulk create makes exactly the requested carriers, all
    //    with the shared tare weight, and reports an accurate count.
    // -----------------------------------------------------------------
    const bulk1 = await call("POST", "/api/carriers/bulk", {
      token: adminToken,
      body: { prefix: BULK_PREFIX, startNumber: 1, endNumber: 5, padding: 3, tareWeightKg: 12.25, notes: "QA bulk" },
    });
    check(
      bulk1.status === 200 && bulk1.body?.createdCount === 5 && bulk1.body?.skippedCount === 0,
      "M) first bulk create makes all 5 carriers with none skipped",
      bulk1.body
    );
    for (const c of bulk1.body?.carriers ?? []) carrierIds.push(c.id);
    check(
      (bulk1.body?.carriers ?? []).every((c: any) => c.tareWeightKg === 12.25),
      "N) every bulk-created carrier got the shared tareWeightKg",
      bulk1.body?.carriers
    );
    check(
      (bulk1.body?.carriers ?? []).some((c: any) => c.name === `${BULK_PREFIX} 001`) &&
        (bulk1.body?.carriers ?? []).some((c: any) => c.name === `${BULK_PREFIX} 005`),
      "O) padded names match the requested width",
      bulk1.body?.carriers
    );

    // -----------------------------------------------------------------
    // P) duplicate handling: re-running an overlapping range skips the
    //    ones that already exist and only creates the new ones — the
    //    whole request still succeeds (partial success), it doesn't
    //    reject the batch outright.
    // -----------------------------------------------------------------
    const bulk2 = await call("POST", "/api/carriers/bulk", {
      token: adminToken,
      body: { prefix: BULK_PREFIX, startNumber: 3, endNumber: 7, padding: 3, tareWeightKg: 12.25 },
    });
    check(
      bulk2.status === 200 && bulk2.body?.createdCount === 2 && bulk2.body?.skippedCount === 3,
      "P) overlapping bulk create skips the 3 that already exist and creates the 2 new ones",
      bulk2.body
    );
    for (const c of bulk2.body?.carriers ?? []) carrierIds.push(c.id);
    check(
      JSON.stringify((bulk2.body?.skippedNames ?? []).slice().sort()) ===
        JSON.stringify([`${BULK_PREFIX} 003`, `${BULK_PREFIX} 004`, `${BULK_PREFIX} 005`].sort()),
      "Q) skippedNames names the exact 3 that already existed",
      bulk2.body?.skippedNames
    );

    // No duplicate rows were actually created in the DB despite two
    // overlapping bulk requests — the unique index is the real guarantee.
    const dbCount = await pool.query(`select count(*) from carriers where lower(trim(name)) = lower(trim($1))`, [`${BULK_PREFIX} 003`]);
    check(Number(dbCount.rows[0].count) === 1, "R) exactly one row exists in the DB for a name hit by both bulk requests", dbCount.rows);
  } finally {
    server.close();

    const client = await pool.connect();
    try {
      await client.query("begin");
      if (carrierIds.length > 0) {
        await client.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]);
      }
      // Belt-and-suspenders: also scope-delete by the RUN_ID-suffixed name
      // prefixes, in case a step above failed before an id was captured.
      await client.query(`delete from carriers where name like $1 or name like $2`, [`${NAME_PREFIX}%`, `${BULK_PREFIX}%`]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }

    const leftover = await pool.query(`select count(*) from carriers where name like $1 or name like $2`, [`${NAME_PREFIX}%`, `${BULK_PREFIX}%`]);
    check(Number(leftover.rows[0].count) === 0, "S) all QA fixtures cleaned up, none left orphaned");

    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
