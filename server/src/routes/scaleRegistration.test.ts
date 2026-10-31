// Integration tests for Register Bins at the weighing station
// (routes/scale.ts /registration*, lib/binRegistration.ts) and the tag/tare
// audit trail shared with Basic Data > Carriers (routes/carriers.ts).
// Real routers over real HTTP against the real database, RUN_ID-suffixed QA
// fixtures, cleanup in one transaction.
//
// Run with: npm run test:scale-registration
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { generateIntegrationToken } from "../lib/integrationToken";
import carriersRouter from "./carriers";
import scaleRouter from "./scale";

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
const N = Number(String(RUN_ID).slice(-7)); // bin numbers unique to this run

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/carriers", carriersRouter);
  app.use("/api/scale", scaleRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const employeeIds: string[] = [];
  const carrierIds: string[] = [];
  const stationIds: string[] = [];

  try {
    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    async function employee(role: string, first: string) {
      const roleId = (await pool.query(`select id from security_roles where name = $1`, [role])).rows[0].id;
      const id = (
        await pool.query(
          `insert into employees (first_name, last_name, security_role_id, team_role_id) values ($1, $2, $3, $4) returning id`,
          [first, `Reg ${RUN_ID}`, roleId, teamRoleId]
        )
      ).rows[0].id as string;
      employeeIds.push(id);
      return { id, token: signSession({ id, firstName: first, lastName: `Reg ${RUN_ID}`, securityRole: role, teamRole: "Team Member" }) };
    }
    const picker = await employee("Employee", "Pia");
    const admin = await employee("Administrator", "Adam");

    const { token: stationToken, tokenHash } = generateIntegrationToken();
    stationIds.push(
      (await pool.query(`insert into scale_stations (name, token_hash) values ($1, $2) returning id`, [`QA Reg ${RUN_ID}`, tokenHash])).rows[0].id
    );

    async function bin(name: string, opts: { tag?: string | null; tare?: number; active?: boolean } = {}) {
      const id = (
        await pool.query(`insert into carriers (name, rfid_tag, tare_weight_kg, is_active) values ($1, $2, $3, $4) returning id`, [
          name,
          opts.tag ?? null,
          opts.tare ?? 0,
          opts.active ?? true,
        ])
      ).rows[0].id as string;
      carrierIds.push(id);
      return id;
    }
    const tag = (i: number) => `${RUN_ID}${i}`.padStart(16, "0");

    async function call(method: string, path: string, opts: { station?: boolean; session?: string; body?: unknown } = {}) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(opts.station === false ? {} : { Authorization: `Bearer ${stationToken}` }),
          ...(opts.session ? { Cookie: `labourlink_session=${opts.session}` } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    }
    // A stable reading of an empty bin, as the station sends it.
    function registration(carrierId: string, rfidTag: string, grossKg: number, expected: { rfidTag: string | null; tareWeightKg: number }, extra: Record<string, unknown> = {}) {
      return {
        registrationId: randomUUID(),
        carrierId,
        rfidTag,
        tareKg: grossKg,
        measured: { grossKg, samplesKg: [grossKg, grossKg, grossKg, grossKg, grossKg, grossKg], status: "gross", stableMs: 2000 },
        expected,
        emptyConfirmed: true,
        ...extra,
      };
    }
    const register = (body: unknown, session = picker.token) => call("POST", "/api/scale/registration", { session, body });
    const carrierRow = async (id: string) =>
      (await pool.query(`select rfid_tag, tare_weight_kg::float8 as tare from carriers where id = $1`, [id])).rows[0];
    const audit = async (id: string) =>
      (await pool.query(`select * from carrier_registration_audit where carrier_id = $1 order by performed_at, action`, [id])).rows;

    const bin77 = await bin(`QA Reg Bin ${N}`);
    const binPadded = await bin(`QA Reg Bin 0${N + 1}`);
    const binInactive = await bin(`QA Reg Bin ${N + 2}`, { active: false });
    const bin3 = await bin(`QA Reg Bin ${N + 3}`, { tag: tag(3), tare: 150 });

    // -----------------------------------------------------------------
    // A) Who may register: any signed-in user, at a registered station
    // -----------------------------------------------------------------
    check((await call("GET", `/api/scale/registration/bins?q=${N}`, { station: false, session: picker.token })).status === 401, "A) a station token is required");
    check((await call("GET", `/api/scale/registration/bins?q=${N}`)).status === 401, "A) a signed-in user is required");
    const found = await call("GET", `/api/scale/registration/bins?q=${N}`, { session: picker.token });
    check(found.status === 200 && found.body.bins.length === 1 && found.body.bins[0].id === bin77, "A) an Employee can look up bins; '77' finds Bin 77", found.body);

    // -----------------------------------------------------------------
    // B) Lookup by number ignores zero padding; inactive bins are not offered
    // -----------------------------------------------------------------
    const padded = await call("GET", `/api/scale/registration/bins?q=${N + 1}`, { session: picker.token });
    check(padded.body.bins.length === 1 && padded.body.bins[0].id === binPadded, "B) '78' finds 'Bin 078'", padded.body);
    const inactive = await call("GET", `/api/scale/registration/bins?q=${N + 2}`, { session: picker.token });
    check(inactive.body.bins.length === 0, "B) inactive bins are not offered", inactive.body);
    const byName = await call("GET", `/api/scale/registration/bins?q=${encodeURIComponent(`Reg Bin ${N + 3}`)}`, { session: picker.token });
    check(byName.body.bins.length === 1 && byName.body.bins[0].id === bin3, "B) a name search works too", byName.body);
    const tagLookup = await call("GET", `/api/scale/registration/tags/${tag(3)}`, { session: picker.token });
    check(tagLookup.body.bin?.id === bin3, "B) a tag lookup names the bin holding it", tagLookup.body);
    const freeTag = await call("GET", `/api/scale/registration/tags/${tag(9)}`, { session: picker.token });
    check(freeTag.status === 200 && freeTag.body.bin === null, "B) a free tag has no bin");

    // -----------------------------------------------------------------
    // C) Refused measurements
    // -----------------------------------------------------------------
    const fresh = { rfidTag: null, tareWeightKg: 0 };
    const refusals: [string, Record<string, unknown>][] = [
      ["not confirmed empty", { emptyConfirmed: false }],
      ["near zero", { tareKg: 1.2, measured: { grossKg: 1.2, samplesKg: [1.2, 1.2, 1.2, 1.2, 1.2], status: "gross", stableMs: 2000 } }],
      ["net mode", { measured: { grossKg: 154.4, samplesKg: [154.4, 154.4, 154.4, 154.4, 154.4], status: "net", stableMs: 2000 } }],
      ["unstable", { measured: { grossKg: 154.4, samplesKg: [154.0, 154.4, 154.9, 154.4, 154.4], status: "gross", stableMs: 2000 } }],
      ["not stable long enough", { measured: { grossKg: 154.4, samplesKg: [154.4, 154.4, 154.4, 154.4, 154.4], status: "gross", stableMs: 500 } }],
      ["tare isn't the measured weight", { tareKg: 150 }],
      ["no RFID tag", { rfidTag: "" }],
      ["no expected values", { expected: undefined }],
    ];
    for (const [label, extra] of refusals) {
      const r = await register({ ...registration(bin77, tag(1), 154.4, fresh), ...extra });
      check(r.status === 400, `C) refused: ${label}`, r.body);
    }
    check((await carrierRow(bin77)).rfid_tag === null, "C) nothing was saved");

    // -----------------------------------------------------------------
    // D) A fresh bin registers; no weighing is created
    // -----------------------------------------------------------------
    const weighingsBefore = (await pool.query(`select count(*)::int as n from scale_weighings`)).rows[0].n;
    const d = registration(bin77, tag(1), 154.4, fresh);
    const r1 = await register(d);
    check(r1.status === 201 && r1.body.carrier.rfidTag === tag(1) && r1.body.carrier.tareWeightKg === 154.4, "D) tag and tare are saved", r1.body);
    const a1 = await audit(bin77);
    check(
      a1.length === 1 &&
        a1[0].action === "register" &&
        a1[0].performed_by_employee_id === picker.id &&
        a1[0].station_id === stationIds[0] &&
        Number(a1[0].measured_gross_kg) === 154.4 &&
        a1[0].empty_confirmed === true &&
        a1[0].old_rfid_tag === null &&
        Number(a1[0].old_tare_weight_kg) === 0,
      "D) the audit row names who, where and what was measured",
      a1
    );
    check((await pool.query(`select count(*)::int as n from scale_weighings`)).rows[0].n === weighingsBefore, "D) registration creates no weighing");
    const replay = await register(d);
    check(replay.status === 200 && replay.body.replay === true && (await audit(bin77)).length === 1, "D) a retried request is applied once", replay.body);
    const reused = await register({ ...d, carrierId: binPadded, expected: fresh });
    check(reused.status === 409 && reused.body.code === "registrationIdReused", "D) a registration id can't be reused for another bin", reused.body);

    // -----------------------------------------------------------------
    // E) Overwrites need confirmation; a stale view is refused
    // -----------------------------------------------------------------
    const current = { rfidTag: tag(1), tareWeightKg: 154.4 };
    const e1 = await register(registration(bin77, tag(1), 155.0, current));
    check(e1.status === 409 && e1.body.code === "needsConfirmation" && e1.body.replacesTare === true && e1.body.replacesTag === false, "E) a different tare needs confirmation", e1.body);
    const e2 = await register(registration(bin77, tag(2), 154.4, current));
    check(e2.status === 409 && e2.body.code === "needsConfirmation" && e2.body.replacesTag === true, "E) a different tag needs confirmation", e2.body);
    const e3 = await register(registration(bin77, tag(1), 155.0, fresh, { confirmOverwrite: true }));
    check(e3.status === 409 && e3.body.code === "stale" && e3.body.current.rfidTag === tag(1), "E) a stale view of the bin is refused", e3.body);
    const e4 = await register(registration(bin77, tag(1), 155.0, current, { confirmOverwrite: true }));
    check(e4.status === 201 && e4.body.carrier.tareWeightKg === 155, "E) confirmed, the tare is replaced", e4.body);
    const a2 = await audit(bin77);
    check(a2.length === 2 && a2[1].overwrite_confirmed === true && Number(a2[1].old_tare_weight_kg) === 154.4, "E) the overwrite is audited with the old tare", a2);
    const same = await register(registration(bin77, tag(1), 155.0, { rfidTag: tag(1), tareWeightKg: 155 }));
    check(same.status === 201, "E) re-measuring the same tare and tag needs no confirmation");

    // -----------------------------------------------------------------
    // F) One tag, one bin; correcting a registration to the wrong bin
    // -----------------------------------------------------------------
    // Bin 3 (tag 3, tare 150) was mistakenly registered with Bin 4's tag and tare.
    const bin4 = await bin(`QA Reg Bin ${N + 4}`, { tare: 0 });
    const mistake = await register(registration(bin3, tag(4), 160.2, { rfidTag: tag(3), tareWeightKg: 150 }, { confirmOverwrite: true }));
    check(mistake.status === 201, "F) (setup) the mistaken registration", mistake.body);
    const f1 = await register(registration(bin4, tag(4), 160.2, fresh));
    check(f1.status === 409 && f1.body.code === "tagOnOtherBin" && f1.body.holder.id === bin3, "F) a tag on another bin is refused and that bin is named", f1.body);
    const f2 = await register(registration(bin4, tag(4), 160.2, fresh, { moveFromCarrierId: randomUUID() }));
    check(f2.status === 409 && f2.body.code === "tagOnOtherBin", "F) moving needs the actual bin that holds the tag", f2.body);
    const f3 = await register(registration(bin4, tag(4), 160.2, fresh, { moveFromCarrierId: bin3 }));
    check(f3.status === 201 && f3.body.carrier.rfidTag === tag(4) && f3.body.movedFrom?.id === bin3, "F) moved explicitly, Bin 4 gets its tag", f3.body);
    const b3 = await carrierRow(bin3);
    check(b3.rfid_tag === null && b3.tare === 150 && f3.body.movedFrom.tareRestored === true, "F) Bin 3 loses the tag and gets its previous tare back", b3);
    const a3 = await audit(bin3);
    check(a3[a3.length - 1].action === "move_tag" && a3[a3.length - 1].moved_to_carrier_id === bin4, "F) the move is audited on Bin 3", a3);
    const tagOwners = (await pool.query(`select count(*)::int as n from carriers where rfid_tag = $1`, [tag(4)])).rows[0].n;
    check(tagOwners === 1, "F) the tag is on exactly one bin");

    // -----------------------------------------------------------------
    // G) Inactive bins can't be registered
    // -----------------------------------------------------------------
    const g1 = await register(registration(binInactive, tag(5), 150, fresh));
    check(g1.status === 409 && g1.body.code === "binInactive", "G) inactive bin refused", g1.body);

    // -----------------------------------------------------------------
    // H) Two people registering the same tag to two bins at once
    // -----------------------------------------------------------------
    const binX = await bin(`QA Reg Bin ${N + 5}`);
    const binY = await bin(`QA Reg Bin ${N + 6}`);
    const [hx, hy] = await Promise.all([register(registration(binX, tag(6), 150, fresh)), register(registration(binY, tag(6), 150, fresh))]);
    check([hx.status, hy.status].sort().join() === "201,409", "H) exactly one of two simultaneous registrations of one tag wins", [hx.body, hy.body]);
    check((await pool.query(`select count(*)::int as n from carriers where rfid_tag = $1`, [tag(6)])).rows[0].n === 1, "H) the tag is on one bin");

    // -----------------------------------------------------------------
    // I) Removing a tag (correction)
    // -----------------------------------------------------------------
    const i0 = await call("POST", "/api/scale/registration/remove-tag", {
      session: picker.token,
      body: { registrationId: randomUUID(), carrierId: bin4, expected: { rfidTag: tag(4), tareWeightKg: 160.2 } },
    });
    check(i0.status === 400, "I) removing needs explicit confirmation", i0.body);
    const i1 = await call("POST", "/api/scale/registration/remove-tag", {
      session: picker.token,
      body: { registrationId: randomUUID(), carrierId: bin4, expected: { rfidTag: tag(4), tareWeightKg: 160.2 }, confirm: true, reason: "Tag fell off" },
    });
    check(i1.status === 201 && i1.body.carrier.rfidTag === null && i1.body.carrier.tareWeightKg === 160.2, "I) the tag is removed, the tare kept", i1.body);
    const a4 = await audit(bin4);
    check(a4[a4.length - 1].action === "remove_tag" && a4[a4.length - 1].reason === "Tag fell off", "I) the removal is audited with its reason", a4);

    // -----------------------------------------------------------------
    // J) Carriers page edits are audited too, and the history shows both
    // -----------------------------------------------------------------
    const j1 = await call("PATCH", `/api/carriers/${bin77}`, { station: false, session: admin.token, body: { tareWeightKg: 156.1 } });
    check(j1.status === 200, "J) admin edits the tare on the Carriers page", j1.body);
    const j2 = await call("PATCH", `/api/carriers/${bin77}`, { station: false, session: admin.token, body: { notes: "unrelated" } });
    check(j2.status === 200, "J) an edit that doesn't touch tag or tare");
    const hist = await call("GET", `/api/carriers/${bin77}/history`, { station: false, session: admin.token });
    const h = hist.body.history;
    check(hist.status === 200 && h.length === 4, "J) history: 3 registrations + 1 page edit (notes edit not recorded)", h);
    check(
      h[0].action === "page_edit" && h[0].source === "carriers_page" && h[0].oldTareWeightKg === 155 && h[0].newTareWeightKg === 156.1 && h[0].performedBy === `Adam Reg ${RUN_ID}`,
      "J) newest first: the page edit, with old and new tare and who",
      h[0]
    );
    check(h[h.length - 1].action === "register" && h[h.length - 1].stationName === `QA Reg ${RUN_ID}` && h[h.length - 1].performedBy === `Pia Reg ${RUN_ID}`, "J) the first registration names the station and the person", h[h.length - 1]);
    const j3 = await call("GET", `/api/carriers/${bin77}/history`, { station: false, session: picker.token });
    check(j3.status === 403, "J) the history page itself keeps Basic Data's roles");
    const created = await call("POST", "/api/carriers", { station: false, session: admin.token, body: { name: `QA Reg Bin ${N + 7}`, tareWeightKg: 12.5 } });
    if (created.body?.carrier?.id) carrierIds.push(created.body.carrier.id);
    const ca = await audit(created.body.carrier.id);
    check(ca.length === 1 && ca[0].action === "page_create" && Number(ca[0].new_tare_weight_kg) === 12.5, "J) creating a bin with a tare is audited", ca);
  } finally {
    server.close();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from carrier_registration_audit where carrier_id = any($1::uuid[]) or performed_by_employee_id = any($2::uuid[])`, [
        carrierIds,
        employeeIds,
      ]);
      await client.query(`delete from carriers where id = any($1::uuid[])`, [carrierIds]);
      await client.query(`delete from scale_stations where id = any($1::uuid[])`, [stationIds]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error("cleanup transaction failed, nothing was removed:", err);
      fail++;
    } finally {
      client.release();
    }
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
