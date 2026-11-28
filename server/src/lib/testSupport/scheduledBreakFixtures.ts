// Shared fixtures for the scheduled/automatic break integration tests
// (mobileTime.scheduledBreaks.test.ts, autoBreaks.test.ts). Test-only.
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { pool } from "../../db";
import mobileTimeRouter from "../../routes/mobileTime";
import inputsRouter from "../../routes/inputs";
import { signSession } from "../../middleware/auth";
import { computeWorkdayTotals } from "../workdayTotals";
import { getDayBoundsUtc, zonedWallTimeToUtc } from "../timezone";

export const RUN_ID = `${Date.now()}`;

let pass = 0;
let fail = 0;
export function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}
export function summary(name: string): number {
  console.log(`${name}: ${pass} passed, ${fail} failed`);
  return fail;
}

// Wall-clock time on a local (America/Toronto) date -> ISO instant.
export function at(day: string, hhmm: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi, s] = hhmm.split(":").map(Number);
  return zonedWallTimeToUtc(y, m, d, h, mi, s ?? 0).toISOString();
}
export function local(d: Date | string | null): string {
  return d ? new Date(d).toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour12: false }) : "open";
}

export interface Server {
  base: string;
  close: () => void;
}
export async function startServer(): Promise<Server> {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/mobile", mobileTimeRouter);
  app.use("/api/inputs", inputsRouter);
  app.use((err: unknown, _q: Request, res: Response, _n: NextFunction) => res.status(500).json({ error: String(err) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

export interface ItemSpec {
  start: string; // "HH:MM:SS"
  end: string;
  isPaid?: boolean;
  fixed?: boolean;
  name?: string;
}

// Defaults mirror production's "Full Breaks" profile (2026-11-28): fixed,
// unpaid 10:00-10:15, 12:00-13:00 and 15:00-15:15; work start rounded up to
// 15 min, work end rounded down to 10 min, break rounding off.
export const FULL_BREAKS: ItemSpec[] = [
  { start: "10:00:00", end: "10:15:00", name: "Morning" },
  { start: "12:00:00", end: "13:00:00", name: "Lunch" },
  { start: "15:00:00", end: "15:15:00", name: "Afternoon" },
];

export async function createProfile(items: ItemSpec[] = FULL_BREAKS, rounding = true): Promise<{ id: string; itemIds: string[] }> {
  const p = (
    await pool.query(
      `insert into break_profiles (name, is_active, work_start_rounding_enabled, work_start_rounding_direction,
         work_start_rounding_interval_minutes, work_end_rounding_enabled, work_end_rounding_direction,
         work_end_rounding_interval_minutes, break_rounding_enabled, break_rounding_direction, break_rounding_interval_minutes)
       values ($1, true, $2, 'clockwise', 15, $2, 'counter_clockwise', 10, false, 'clockwise', 15) returning id`,
      [`QA SB Profile ${randomUUID()}`, rounding]
    )
  ).rows[0].id as string;
  const itemIds: string[] = [];
  let i = 0;
  for (const it of items) {
    const r = await pool.query(
      `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, fixed_break, sort_order, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, true) returning id`,
      [p, it.name ?? "Break", it.start, it.end, it.isPaid ?? false, it.fixed ?? true, i++]
    );
    itemIds.push(r.rows[0].id);
  }
  // A real profile exists long before the windows these tests replay (a
  // schedule edited after a window started never applies to it).
  await pool.query(`update break_profile_items set created_at = '2000-01-01', updated_at = '2000-01-01' where break_profile_id = $1`, [p]);
  return { id: p, itemIds };
}

let cachedActivities: { A: string; B: string } | null = null;
export async function activities(): Promise<{ A: string; B: string }> {
  if (cachedActivities) return cachedActivities;
  const mk = async (n: string) =>
    (await pool.query(`insert into activities (name, is_active, minimum_duration_minutes) values ($1, true, 0) returning id`, [`${n} ${randomUUID().slice(0, 8)}`]))
      .rows[0].id as string;
  cachedActivities = { A: await mk("QA SB Picking"), B: await mk("QA SB Pruning") };
  return cachedActivities;
}

export interface Emp {
  id: string;
  device: string;
  deviceId: string;
  seq: number;
}

export async function createEmployee(
  profileId: string | null,
  opts: { autoBreaks?: boolean; autoFrom?: string } = {}
): Promise<Emp> {
  const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
  const roleId = (await pool.query(`select id from security_roles where name = 'Employee'`)).rows[0].id;
  const { A, B } = await activities();
  const e = (
    await pool.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active, break_profile_id)
       values ('QA', $1, $2, $3, $4, 'x', true, $5) returning id`,
      [`SB ${RUN_ID}`, `qa-sb-${randomUUID()}@test.local`, roleId, teamRoleId, profileId]
    )
  ).rows[0].id as string;
  if (opts.autoBreaks) {
    await pool.query(`update employees set auto_breaks_enabled = true, auto_breaks_effective_from = $2 where id = $1`, [
      e,
      opts.autoFrom ?? "2000-01-01T00:00:00Z",
    ]);
  }
  const ident = randomUUID();
  const d = (await pool.query(`insert into devices (device_identifier, device_name, is_active) values ($1, $2, true) returning id`, [ident, `QA SB ${ident}`]))
    .rows[0].id as string;
  await pool.query(`insert into device_assignments (device_id, employee_id) values ($1, $2)`, [d, e]);
  await pool.query(`insert into employee_activity_assignments (employee_id, activity_id) values ($1, $2), ($1, $3)`, [e, A, B]);
  return { id: e, device: ident, deviceId: d, seq: 0 };
}

export type Ev = [type: string, at: string, activityId?: string];

export function makeEvents(emp: Emp, evs: Ev[]) {
  return evs.map(([eventType, occurredAtUtc, activityId]) => ({
    clientEventId: randomUUID(),
    deviceSeq: ++emp.seq,
    eventType,
    occurredAtUtc,
    activityId,
  }));
}

export async function sendEvents(server: Server, emp: Emp, events: unknown[]): Promise<{ status: number; results: { status: string; detail?: unknown }[] }> {
  const res = await fetch(`${server.base}/api/mobile/sync/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Id": emp.device },
    body: JSON.stringify({ events }),
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, results: body?.results ?? [] };
}

export async function sync(server: Server, emp: Emp, evs: Ev[]) {
  return sendEvents(server, emp, makeEvents(emp, evs));
}

// An Administrator session for the Inputs routes.
export async function adminToken(): Promise<{ id: string; token: string }> {
  const teamRoleId = (await pool.query(`select id from team_roles where name = 'Team Member'`)).rows[0].id;
  const roleId = (await pool.query(`select id from security_roles where name = 'Administrator'`)).rows[0].id;
  const id = (
    await pool.query(
      `insert into employees (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
       values ('QA', $1, $2, $3, $4, 'x', true) returning id`,
      [`SB Admin ${RUN_ID}`, `qa-sb-admin-${randomUUID()}@test.local`, roleId, teamRoleId]
    )
  ).rows[0].id as string;
  return { id, token: signSession({ id, firstName: "QA", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" }) };
}

export async function inputs(server: Server, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.base}/api/inputs${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: `labourlink_session=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Direct (online) mobile routes, for a tap sent outside the sync queue.
export async function direct(server: Server, emp: Emp, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.base}/api/mobile${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Id": emp.device },
    body: JSON.stringify({ idempotencyKey: randomUUID(), ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function me(server: Server, emp: Emp): Promise<any> {
  const res = await fetch(`${server.base}/api/mobile/me`, { headers: { "X-Device-Id": emp.device } });
  return res.json();
}

export interface Row {
  id: string;
  entry_type: "work" | "break";
  activity_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  actual_started_at: Date | null;
  actual_ended_at: Date | null;
  is_paid: boolean | null;
  source: string;
  deleted_at: Date | null;
  greenhouse_row_id: string | null;
  carrier_id: string | null;
  density_type: string | null;
  density_count_per_row: number | null;
  break_profile_item_id: string | null;
  break_occurrence_id: string | null;
  created_by_employee_id: string | null;
}

export async function rows(emp: Emp): Promise<Row[]> {
  const { rows } = await pool.query(
    `select id, entry_type, activity_id, started_at, ended_at, actual_started_at, actual_ended_at, is_paid, source,
            deleted_at, greenhouse_row_id, carrier_id, density_type, density_count_per_row, break_profile_item_id,
            break_occurrence_id, created_by_employee_id
     from time_entries where employee_id = $1 order by started_at, created_at`,
    [emp.id]
  );
  return rows;
}

export function live(rs: Row[]): Row[] {
  return rs.filter((r) => !r.deleted_at);
}

export function describe(rs: Row[]): string {
  return rs
    .map((r) => `${r.deleted_at ? "VOID " : ""}${r.entry_type} ${local(r.started_at)}-${local(r.ended_at)}`)
    .join(", ");
}

// Pairs of non-deleted entries whose intervals overlap (open = until now).
export function overlaps(rs: Row[]): string[] {
  const l = live(rs);
  const out: string[] = [];
  for (let i = 0; i < l.length; i++)
    for (let j = i + 1; j < l.length; j++) {
      const a = l[i],
        b = l[j];
      const ae = a.ended_at ? +a.ended_at : Date.now();
      const be = b.ended_at ? +b.ended_at : Date.now();
      if (+a.started_at < be && +b.started_at < ae) out.push(`${a.entry_type} ${local(a.started_at)}-${local(a.ended_at)} x ${b.entry_type} ${local(b.started_at)}-${local(b.ended_at)}`);
    }
  return out;
}

export function paidHours(rs: Row[], day: string, clipFrom: string | null = null): number {
  const { start, end } = getDayBoundsUtc(day);
  const l = live(rs).filter((r) => +r.started_at >= +start && +r.started_at < +end);
  const t = computeWorkdayTotals(
    l.map((r) => ({ entryType: r.entry_type, startedAt: new Date(r.started_at), endedAt: r.ended_at ? new Date(r.ended_at) : null, isPaid: r.is_paid })),
    new Date(),
    { unpaidBreakSpanClipFrom: clipFrom }
  );
  return Math.round((t.workedSeconds / 3600) * 1000) / 1000;
}

export function sameInstant(a: Date | string | null, b: Date | string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}
