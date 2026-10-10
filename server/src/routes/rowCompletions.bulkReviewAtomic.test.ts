// Regression test for the 2026-10-10 bulk speed review failure.
//
// Production: "Review speeds — all employees" for Wed Oct 7 (Row review
// window 3 days), 8 groups selected — 6 to merge (same-employee visits, some
// spanning Oct 7 and 8) and 2 to keep separate (rows also visited by another
// employee), 7 employees. A Railway deploy restarted the API part-way
// through Apply: the old route committed group by group, so 6 groups were
// saved and 2 weren't, and the browser only showed "Request failed".
//
// Rebuilds that mix and checks POST /api/row-completions/bulk-review:
//   A. grouping for the mix (cross-date merge groups, shared-row separate groups);
//   B. the batch failing part-way (an injected database error on the 7th
//      group, standing in for the process dying) saves NOTHING;
//   C. retrying after the old partial save (6 already saved) saves only the
//      remaining 2 and reports the 6 as already saved — no double counting;
//   D. retrying an identical, already-applied batch is a no-op;
//   E. a group resolved differently since the review was opened is stale:
//      nothing in that batch is saved, then the rest saves on its own;
//   F. two concurrent identical submissions save exactly once.
// Speed totals (attribution) are checked to count each row's stems once.
//
// Run with: npm run test:row-completion-bulk-review-atomic
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { pool } from "../db";
import { signSession } from "../middleware/auth";
import { getRangeBoundsUtc, zonedWallTimeToUtc } from "../lib/timezone";
import { getActivityDensityAttribution } from "../lib/reportQueries";
import rowCompletionsRouter from "./rowCompletions";

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
const STEMS = 636;
const D = "2019-11-06"; // a Wednesday, like Oct 7 2026
const D_NEXT = "2019-11-07";
const D_PREV = "2019-11-05";
const TRIGGER_FN = `qa_bulk_fail_${RUN_ID}`;

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/row-completions", rowCompletionsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Internal server error", detail: String(err) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const employeeIds: string[] = [];
  const rowIds: string[] = [];
  let activityId: string | undefined;
  let landId: string | undefined;
  let phaseId: string | undefined;
  let originalWindow: number | null = null;

  try {
    originalWindow = (await pool.query(`select row_review_window_days from org_settings where id = true`)).rows[0]?.row_review_window_days ?? null;
    await pool.query(`update org_settings set row_review_window_days = 3 where id = true`);

    const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
    const roleId = async (name: string) => (await pool.query(`select id from security_roles where name = $1`, [name])).rows[0].id;
    const fakePinHash = "$2a$10$QAplaceholderQAplaceholderQAplaceholderQAplaceholde";
    async function employee(label: string, role = "Employee") {
      const lastName = `Bulk Atomic ${label} ${RUN_ID}`;
      const { rows } = await pool.query(
        `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
         values ('QA', $1, $2, $3, $4, $5, true) returning id`,
        [lastName, `qa-bulk-atomic-${label.toLowerCase()}-${RUN_ID}@test.local`, await roleId(role), teamRoleId, fakePinHash]
      );
      employeeIds.push(rows[0].id);
      return { id: rows[0].id as string, token: signSession({ id: rows[0].id, firstName: "QA", lastName, securityRole: role, teamRole: "Team Member" }) };
    }
    landId = (await pool.query(`insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ($1, 300, 100) returning id`, [`QA Atomic Land ${RUN_ID}`])).rows[0].id;
    phaseId = (
      await pool.query(`insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet) values ($1, $2, 300, 100) returning id`, [landId, `QA Atomic Phase ${RUN_ID}`])
    ).rows[0].id;
    async function row(n: number) {
      const { rows } = await pool.query(
        `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation) values ($1, $2, 0, $3, 2, 20, 'horizontal') returning id`,
        [phaseId, n, n * 3]
      );
      rowIds.push(rows[0].id);
      return rows[0].id as string;
    }
    const at = (date: string, h: number, m: number) => {
      const [y, mo, d] = date.split("-").map(Number);
      return zonedWallTimeToUtc(y, mo, d, h, m, 0);
    };
    async function visit(emp: string, r: string, date: string, s: [number, number], e: [number, number]) {
      const { rows } = await pool.query(
        `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key, started_at, ended_at, source,
                                   greenhouse_row_id, density_type, density_count_per_row)
         values ($1, null, 'work', $2, gen_random_uuid(), $3, $4, 'manual', $5, 'stems', $6) returning id`,
        [emp, activityId, at(date, ...s), at(date, ...e), r, STEMS]
      );
      return rows[0].id as string;
    }

    const admin = await employee("Admin", "Administrator");
    activityId = (await pool.query(`insert into activities (name, is_active, density_source) values ($1, true, 'stems') returning id`, [`QA Atomic Picking ${RUN_ID}`])).rows[0].id;
    const [e1, e2, e3, e4, e5, e6, e7, c1, c2] = await Promise.all(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "C1", "C2"].map((l) => employee(l)));
    const rows: Record<string, string> = {};
    for (const n of [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 198, 199]) rows[n] = await row(n);

    // Six merge groups: the same employee back on a row within the 3-day
    // cycle, four of them spanning D and D+1.
    await visit(e1.id, rows[101], D, [7, 0], [8, 0]);
    await visit(e1.id, rows[101], D_NEXT, [7, 0], [7, 40]);
    await visit(e2.id, rows[102], D, [7, 0], [8, 0]);
    await visit(e2.id, rows[102], D_NEXT, [9, 0], [9, 30]);
    await visit(e3.id, rows[103], D, [7, 0], [8, 0]);
    await visit(e3.id, rows[199], D, [8, 0], [9, 0]);
    await visit(e3.id, rows[103], D, [9, 0], [9, 30]);
    await visit(e3.id, rows[104], D, [13, 0], [14, 0]);
    await visit(e3.id, rows[104], D_NEXT, [7, 0], [8, 0]);
    await visit(e4.id, rows[105], D, [7, 0], [8, 0]);
    await visit(e4.id, rows[198], D, [8, 0], [9, 0]);
    await visit(e4.id, rows[105], D, [9, 0], [10, 0]);
    await visit(e5.id, rows[106], D, [7, 0], [8, 0]);
    await visit(e5.id, rows[106], D_NEXT, [7, 0], [8, 0]);
    // Two keep-separate groups: rows also visited by another employee
    // within the cycle (same day / the day before).
    await visit(e6.id, rows[107], D, [8, 0], [9, 0]);
    await visit(c1.id, rows[107], D, [10, 0], [11, 0]);
    await visit(e7.id, rows[108], D, [8, 0], [9, 0]);
    await visit(c2.id, rows[108], D_PREV, [15, 0], [16, 0]);
    // For E/F: E1 twice on row 109, E2 twice on row 110 (with another row between).
    const r109a = await visit(e1.id, rows[109], D, [10, 0], [11, 0]);
    await visit(e1.id, rows[198], D, [11, 0], [11, 30]);
    const r109b = await visit(e1.id, rows[109], D, [11, 30], [12, 0]);
    await visit(e2.id, rows[110], D, [10, 0], [11, 0]);
    await visit(e2.id, rows[199], D, [11, 0], [11, 30]);
    await visit(e2.id, rows[110], D, [11, 30], [12, 0]);

    // ---- A) Grouping for the production mix --------------------------------
    const review = await call("GET", `/api/row-completions/review-groups?date=${D}`, admin.token);
    const all: any[] = review.body?.groups ?? [];
    const groupFor = (emp: string, r: string) => all.find((g) => g.employeeId === emp && g.greenhouseRowId === r);
    const merges = [
      groupFor(e1.id, rows[101]),
      groupFor(e2.id, rows[102]),
      groupFor(e3.id, rows[103]),
      groupFor(e3.id, rows[104]),
      groupFor(e4.id, rows[105]),
      groupFor(e5.id, rows[106]),
    ];
    const separates = [groupFor(e6.id, rows[107]), groupFor(e7.id, rows[108])];
    check(review.status === 200 && review.body?.windowDays === 3, "A) review loads with the 3-day window", review.body?.windowDays);
    check(merges.every((g) => g?.actions.merge.available && g.suggestedAction === "merge"), "A) six merge groups, merge suggested", merges.map((g) => g?.rowLabel));
    check(merges.filter((g) => g?.spansDates.length === 2).length === 4, "A) four of them span two days", merges.map((g) => g?.spansDates));
    check(separates.every((g) => g?.actions.separate.available && g.contextVisits.length === 1), "A) two keep-separate groups on rows shared with another employee", separates);
    if (![...merges, ...separates].every(Boolean)) throw new Error("fixture groups missing — cannot continue");
    const batch = [
      ...merges.map((g) => ({ groupId: g.id, action: "merge", visits: g.visits.map((v: any) => v.segmentIds) })),
      ...separates.map((g) => ({ groupId: g.id, action: "separate", visits: g.visits.map((v: any) => v.segmentIds) })),
    ];
    check(new Set([...merges, ...separates].map((g) => g.employeeId)).size === 7, "A) 8 groups, 7 employees affected");
    const eightRows = [rows[101], rows[102], rows[103], rows[104], rows[105], rows[106], rows[107], rows[108]];
    const completionCount = async (rowList: string[]) =>
      Number((await pool.query(`select count(*)::int as n from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowList])).rows[0].n);
    const segmentLinks = async (rowList: string[]) =>
      Number(
        (
          await pool.query(
            `select count(*)::int as n from row_completion_segments rcs join row_completions rc on rc.id = rcs.row_completion_id where rc.greenhouse_row_id = any($1::uuid[])`,
            [rowList]
          )
        ).rows[0].n
      );

    // ---- B) The batch fails part-way: nothing is saved ---------------------
    // A database error on the 7th group (the first keep-separate), after six
    // merges were already written in the same request — what a crash or
    // deploy restart mid-request looks like to the database.
    const seventhSegment = separates[0].visits[0].segmentIds[0];
    await pool.query(
      `create function ${TRIGGER_FN}() returns trigger language plpgsql as $$
       begin
         if new.time_entry_id = '${seventhSegment}'::uuid then raise exception 'qa injected failure'; end if;
         return new;
       end $$`
    );
    await pool.query(`create trigger ${TRIGGER_FN} before insert on row_completion_segments for each row execute function ${TRIGGER_FN}()`);
    const failed = await call("POST", "/api/row-completions/bulk-review", admin.token, { date: D, groups: batch });
    await pool.query(`drop trigger if exists ${TRIGGER_FN} on row_completion_segments`);
    await pool.query(`drop function if exists ${TRIGGER_FN}()`);
    check(
      failed.status === 500 && failed.body?.saved === false && failed.body?.code === "BULK_REVIEW_FAILED" && /nothing was saved/i.test(failed.body?.error ?? ""),
      "B) a failure part-way through answers saved: false and says nothing was saved",
      failed.body
    );
    check((await completionCount(eightRows)) === 0, "B) not one of the eight groups was saved (the old route left six saved)", await completionCount(eightRows));
    const stillPending = ((await call("GET", `/api/row-completions/review-groups?date=${D}`, admin.token)).body?.groups ?? []).map((g: any) => g.id);
    check(batch.every((b) => stillPending.includes(b.groupId)), "B) all eight groups are still pending in the review");

    // ---- C) Retry after the old partial save ------------------------------
    // Recreate production's state: the six merges saved one by one (as the
    // old route did before the restart), the two keep-separate groups not.
    for (const g of merges) {
      const r = await call("POST", "/api/row-completions", admin.token, { timeEntryIds: g.visits.flatMap((v: any) => v.segmentIds) });
      if (r.status !== 201) throw new Error(`setup: legacy merge failed ${JSON.stringify(r.body)}`);
    }
    const retry = await call("POST", "/api/row-completions/bulk-review", admin.token, { date: D, groups: batch });
    const retryById = new Map((retry.body?.results ?? []).map((r: any) => [r.groupId, r]));
    check(retry.status === 200 && retry.body?.saved === true, "C) retrying the same 8 selections succeeds", retry.body);
    check(merges.every((g) => (retryById.get(g.id) as any)?.alreadySaved === true), "C) the six already-saved merges are reported as already saved, not redone", retry.body?.results);
    check(
      separates.every((g) => (retryById.get(g.id) as any)?.ok === true && (retryById.get(g.id) as any)?.completionIds?.length === 1),
      "C) the two keep-separate groups are saved now",
      retry.body?.results
    );
    check((await completionCount(eightRows)) === 8, "C) exactly 8 completions: six merges + two single-visit completions", await completionCount(eightRows));
    const expectedLinks = batch.reduce((n, b) => n + b.visits.flat().length, 0);
    check((await segmentLinks(eightRows)) === expectedLinks, "C) every segment is linked exactly once", { links: await segmentLinks(eightRows), expectedLinks });

    const { start, end } = getRangeBoundsUtc(D_PREV, D_NEXT);
    const attributionAfterC = await getActivityDensityAttribution(activityId!, start, end);
    const qty = (emp: string) => attributionAfterC.byEmployee.get(emp)?.quantity ?? 0;
    check(
      [e1, e2, e4, e5].every((e) => qty(e.id) >= STEMS) && qty(e3.id) >= 2 * STEMS,
      "C) attribution counts each merged row's stems once per row (not per visit)",
      Object.fromEntries([e1, e2, e3, e4, e5].map((e) => [e.id.slice(0, 6), qty(e.id)]))
    );

    // ---- D) Identical retry after success: no-op ---------------------------
    const replay = await call("POST", "/api/row-completions/bulk-review", admin.token, { date: D, groups: batch });
    check(replay.status === 200 && replay.body?.results?.every((r: any) => r.ok && r.alreadySaved), "D) an identical retry reports every group already saved", replay.body);
    check((await completionCount(eightRows)) === 8 && (await segmentLinks(eightRows)) === expectedLinks, "D) ...and creates nothing");
    const attributionAfterD = await getActivityDensityAttribution(activityId!, start, end);
    check(
      JSON.stringify([...attributionAfterD.byEmployee.entries()].sort()) === JSON.stringify([...attributionAfterC.byEmployee.entries()].sort()),
      "D) speed totals are unchanged by the retry (no double-counted stems)"
    );

    // ---- E) Stale group: resolved differently since the review opened ------
    const fresh = (await call("GET", `/api/row-completions/review-groups?date=${D}`, admin.token)).body?.groups ?? [];
    const g109 = fresh.find((g: any) => g.greenhouseRowId === rows[109]);
    const g110 = fresh.find((g: any) => g.greenhouseRowId === rows[110]);
    check(g109?.actions.merge.available && g110?.actions.merge.available, "E) setup: rows 109 and 110 each have a merge group");
    // Someone keeps row 109's two visits separate from the individual review first.
    for (const id of [r109a, r109b]) await call("POST", "/api/row-completions", admin.token, { timeEntryIds: [id] });
    const staleBatch = [
      { groupId: g109.id, action: "merge", visits: g109.visits.map((v: any) => v.segmentIds) },
      { groupId: g110.id, action: "merge", visits: g110.visits.map((v: any) => v.segmentIds) },
    ];
    const stale = await call("POST", "/api/row-completions/bulk-review", admin.token, { date: D, groups: staleBatch });
    const staleById = new Map((stale.body?.results ?? []).map((r: any) => [r.groupId, r]));
    check(
      stale.status === 409 && stale.body?.code === "BULK_REVIEW_STALE" && stale.body?.saved === false,
      "E) a batch with a group resolved differently is refused and saves nothing",
      stale.body
    );
    check((staleById.get(g109.id) as any)?.status === "stale" && !(staleById.get(g109.id) as any)?.alreadySaved, "E) row 109 is stale — kept separate elsewhere is not 'already merged'", staleById.get(g109.id));
    check((staleById.get(g110.id) as any)?.status === "ready", "E) row 110 is reported ready");
    check((await completionCount([rows[110]])) === 0, "E) row 110 was not saved by the refused batch");
    const rest = await call("POST", "/api/row-completions/bulk-review", admin.token, { date: D, groups: [staleBatch[1]] });
    check(rest.status === 200 && rest.body?.saved === true && (await completionCount([rows[110]])) === 1, "E) applying the remaining group on its own saves it", rest.body);

    // ---- F) Concurrent identical submissions save exactly once -------------
    await visit(e7.id, rows[198], D_NEXT, [7, 0], [8, 0]);
    await visit(e7.id, rows[199], D_NEXT, [8, 0], [8, 30]);
    await visit(e7.id, rows[198], D_NEXT, [8, 30], [9, 0]);
    const nextGroups = (await call("GET", `/api/row-completions/review-groups?date=${D_NEXT}`, admin.token)).body?.groups ?? [];
    const g198 = nextGroups.find((g: any) => g.employeeId === e7.id && g.greenhouseRowId === rows[198]);
    check(g198?.actions.merge.available, "F) setup: a fresh merge group", g198);
    const fBody = { date: D_NEXT, groups: [{ groupId: g198.id, action: "merge", visits: g198.visits.map((v: any) => v.segmentIds) }] };
    const [p1, p2] = await Promise.all([
      call("POST", "/api/row-completions/bulk-review", admin.token, fBody),
      call("POST", "/api/row-completions/bulk-review", admin.token, fBody),
    ]);
    const savedNew = [p1, p2].filter((p) => p.status === 200 && p.body?.results?.[0]?.completionIds?.length === 1).length;
    const others = [p1, p2].filter((p) => !(p.status === 200 && p.body?.results?.[0]?.completionIds?.length === 1));
    check(savedNew === 1, "F) exactly one of two concurrent submissions created the completion", [p1.body, p2.body]);
    check(
      others.every((p) => (p.status === 200 && p.body?.results?.[0]?.alreadySaved) || (p.status === 409 && p.body?.saved === false)),
      "F) the other reports already saved or 'nothing was saved' — never a duplicate",
      others.map((p) => p.body)
    );
    const g198Links = Number(
      (await pool.query(
        `select count(*)::int as n from row_completion_segments where time_entry_id = any($1::uuid[])`,
        [g198.visits.flatMap((v: any) => v.segmentIds)]
      )).rows[0].n
    );
    check(g198Links === g198.visits.flatMap((v: any) => v.segmentIds).length, "F) each segment linked once");
  } finally {
    server.close();
    await pool.query(`drop trigger if exists ${TRIGGER_FN} on row_completion_segments`).catch(() => {});
    await pool.query(`drop function if exists ${TRIGGER_FN}()`).catch(() => {});
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `delete from row_completion_segments where row_completion_id in (select id from row_completions where greenhouse_row_id = any($1::uuid[]))`,
        [rowIds]
      );
      await client.query(`delete from row_completions where greenhouse_row_id = any($1::uuid[])`, [rowIds]);
      await client.query(`delete from time_entries where employee_id = any($1::uuid[])`, [employeeIds]);
      await client.query(`delete from greenhouse_rows where id = any($1::uuid[])`, [rowIds]);
      if (phaseId) await client.query(`delete from greenhouse_phases where id = $1`, [phaseId]);
      if (landId) await client.query(`delete from greenhouse_lands where id = $1`, [landId]);
      if (activityId) await client.query(`delete from activities where id = $1`, [activityId]);
      await client.query(`delete from employees where id = any($1::uuid[])`, [employeeIds]);
      if (originalWindow !== null) await client.query(`update org_settings set row_review_window_days = $1 where id = true`, [originalWindow]);
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
