// Which greenhouse rows a weighed bin was picked in (Scale Weighings page).
//
// Read-only and display-only: nothing here decides a weighing, a credit or a
// picking cycle. It reads the decisions already made and the time entries
// behind them, and answers "unknown" (shown as —) whenever one bin use can't
// be told apart from another.
//
// The bin use behind a weighing:
// * Picking-cycle tracking (074/075): the cycle this weighing closed
//   (bin_cycles.weighing_id, which follows an administrator's "credit this
//   cycle instead"). Its employee, from the cycle's first scan to the
//   weighing. Superseded cycles (earlier uses by someone else) are never
//   included.
// * Before tracking (the original rule): only a weighing credited (or
//   credited, then voided) to one employee. That employee, from their first
//   claim to the weighing. A needs-review weighing had several employees in
//   one use; a pending or expired one has nobody yet.
//
// The rows are that employee's work time entries with this bin, as they are
// now (after any Inputs corrections), that overlap the bin use. A use that
// started on an earlier calendar day than the weighing is "unknown": the bin
// may have been emptied unweighed in between, and the old rows can't be told
// apart from the new ones.
import { Pool, PoolClient } from "pg";
import { calendarDateInAppTimezone } from "./timezone";

export interface WeighingRow {
  id: string;
  phaseName: string;
  rowNumber: number;
  label: string;
}

export type WeighingRows =
  | { status: "known"; rows: WeighingRow[] }
  | { status: "unknown"; reason: string };

export const ROWS_REASONS = {
  noCycle: "No picking cycle is linked to this weighing, so its rows aren't known.",
  severalInCycle: "More than one employee scanned this bin in its picking cycle, so its rows can't be told apart.",
  competing: "This weighing needs review (usually more than one employee chose the bin), so its rows can't be told apart.",
  nobody: "Nobody chose this bin on a phone for this weighing, so its rows aren't known.",
  earlierDay: "This bin use started on an earlier day, so rows from an earlier use of the bin can't be ruled out.",
  noRows: "No greenhouse row was recorded with this bin during this bin use.",
  duplicate: "A repeat weighing of the same bin within five minutes; the rows are on the first weighing.",
} as const;

interface WeighingRef {
  id: string;
  carrier_id: string;
  weighed_at: Date | string;
  status: string;
  employee_id: string | null;
  is_duplicate: boolean;
}

interface UseWindow {
  weighingId: string;
  employeeId: string;
  carrierId: string;
  from: Date;
  to: Date;
}

const sameAppDay = (a: Date, b: Date) => calendarDateInAppTimezone(a) === calendarDateInAppTimezone(b);

export async function loadWeighingRows(db: Pool | PoolClient, weighings: WeighingRef[]): Promise<Map<string, WeighingRows>> {
  const out = new Map<string, WeighingRows>();
  if (weighings.length === 0) return out;
  const ids = weighings.map((w) => w.id);

  const [periods, cycles, claims] = await Promise.all([
    db.query<{ started_at: Date; stopped_at: Date | null }>(`select started_at, stopped_at from bin_cycle_tracking`),
    db.query<{ weighing_id: string; employee_id: string; opened_at: Date; scan_employees: number }>(
      `select bc.weighing_id, bc.employee_id, bc.opened_at,
              (select count(distinct s.employee_id)::int from bin_scans s where s.cycle_id = bc.id) as scan_employees
       from bin_cycles bc where bc.weighing_id = any($1::uuid[])`,
      [ids]
    ),
    db.query<{ weighing_id: string; employees: number; employee_id: string; first_claim: Date }>(
      `select cl.weighing_id, count(distinct cl.employee_id)::int as employees, min(cl.employee_id::text) as employee_id,
              min(m.occurred_at_utc) as first_claim
       from scale_weighing_claims cl join mobile_time_events m on m.id = cl.mobile_time_event_id
       where cl.weighing_id = any($1::uuid[]) group by cl.weighing_id`,
      [ids]
    ),
  ]);
  const inPeriod = (t: Date) => periods.rows.some((p) => t > new Date(p.started_at) && (!p.stopped_at || t <= new Date(p.stopped_at)));
  const cycleByWeighing = new Map(cycles.rows.map((c) => [c.weighing_id, c]));
  const claimsByWeighing = new Map(claims.rows.map((c) => [c.weighing_id, c]));

  const windows: UseWindow[] = [];
  for (const w of weighings) {
    const weighedAt = new Date(w.weighed_at);
    const unknown = (reason: string) => out.set(w.id, { status: "unknown", reason });
    let employeeId: string;
    let from: Date;
    const cycle = cycleByWeighing.get(w.id);
    if (w.is_duplicate) {
      unknown(ROWS_REASONS.duplicate);
      continue;
    }
    if (inPeriod(weighedAt)) {
      if (!cycle) {
        unknown(ROWS_REASONS.noCycle);
        continue;
      }
      if (cycle.scan_employees > 1) {
        unknown(ROWS_REASONS.severalInCycle);
        continue;
      }
      employeeId = cycle.employee_id;
      from = new Date(cycle.opened_at);
    } else {
      const c = claimsByWeighing.get(w.id);
      if (c && c.employees > 1) {
        unknown(ROWS_REASONS.competing);
        continue;
      }
      if (w.status === "needs_review") {
        // Competing claims are flags, not claims: several employees, or an
        // anomaly held for review. Either way, no one bin use to show.
        unknown(ROWS_REASONS.competing);
        continue;
      }
      if (!c || !(w.status === "credited" || w.status === "voided")) {
        unknown(ROWS_REASONS.nobody);
        continue;
      }
      employeeId = c.employee_id;
      from = new Date(c.first_claim);
    }
    if (!sameAppDay(from, weighedAt)) {
      unknown(ROWS_REASONS.earlierDay);
      continue;
    }
    windows.push({ weighingId: w.id, employeeId, carrierId: w.carrier_id, from, to: weighedAt });
  }

  if (windows.length) {
    const { rows } = await db.query<{ weighing_id: string; row_id: string; row_number: number; phase_name: string }>(
      `select distinct x.weighing_id, gr.id as row_id, gr.row_number, gp.name as phase_name
       from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::timestamptz[], $5::timestamptz[])
              as x(weighing_id, employee_id, carrier_id, from_at, to_at)
       join time_entries te
         on te.employee_id = x.employee_id
        and te.carrier_id = x.carrier_id
        and te.entry_type = 'work'
        and te.deleted_at is null
        and te.started_at < x.to_at
        and coalesce(te.ended_at, 'infinity'::timestamptz) > x.from_at
       join greenhouse_rows gr on gr.id = te.greenhouse_row_id
       join greenhouse_phases gp on gp.id = gr.phase_id`,
      [
        windows.map((x) => x.weighingId),
        windows.map((x) => x.employeeId),
        windows.map((x) => x.carrierId),
        windows.map((x) => x.from),
        windows.map((x) => x.to),
      ]
    );
    const byWeighing = new Map<string, WeighingRow[]>();
    for (const r of rows) {
      const list = byWeighing.get(r.weighing_id) ?? [];
      list.push({ id: r.row_id, phaseName: r.phase_name, rowNumber: r.row_number, label: `${r.phase_name} · Row ${r.row_number}` });
      byWeighing.set(r.weighing_id, list);
    }
    const collator = new Intl.Collator(undefined, { numeric: true });
    for (const x of windows) {
      const list = (byWeighing.get(x.weighingId) ?? []).sort((a, b) => collator.compare(a.phaseName, b.phaseName) || a.rowNumber - b.rowNumber);
      out.set(x.weighingId, list.length ? { status: "known", rows: list } : { status: "unknown", reason: ROWS_REASONS.noRows });
    }
  }
  return out;
}
