// Shared live-state derivation for the greenhouse map — used by BOTH the
// authenticated office endpoint (GET /api/greenhouse/live) and the
// token-authed TV endpoint (GET /api/greenhouse/display/:displayKey/state).
// One query shape, one place row state is defined, so the two pages can
// never silently drift apart. Never stored on greenhouse_rows itself (see
// 013_greenhouse_rows.sql — no state/color column exists there, deliberately)
// — always derived fresh from time_entries.
//
// Blue = an open work entry (optionally matching an activity filter) that
// existed as of the range's end (ended_at is null, started_at < rangeEnd) —
// not lower-bounded by rangeStart, so a still-open entry correctly shows
// blue on every date from when it started onward (including a
// forgotten-to-end-shift on a past date) while never fabricating blue on a
// date before the entry existed.
//
// Green = no matching open entry, but at least one completed qualifying
// work entry with started_at inside [rangeStart, rangeEnd) — same
// date-scoping convention inputs.ts's GET /daily already uses.
//
// Blue always wins over green. An activity filter is applied identically to
// both branches, so a row completed only via a non-matching activity
// produces neither and correctly falls through to neutral — it is never
// marked green just because some unrelated activity happened there.
//
// Both branches filter on te.deleted_at is null (time_entries.deleted_at,
// added by migration 012 — soft-deleting an erroneous log via the Inputs
// page) — a deleted entry must never keep a row painted blue/green forever.
// That migration is intentionally not part of this feature's commit (it
// belongs to a separate, still-uncommitted Inputs correction/deletion
// feature); this file depends on it having been applied to the database
// regardless, which is already true of the live database this runs
// against. A fresh database built only from this repo's committed
// migrations up to this point would be missing that column until 012 lands
// on its own.
export interface LiveStateParams {
  landId: string;
  rangeStart: Date;
  rangeEnd: Date;
  activityId?: string | null;
}

export function buildLiveLandQuery(params: LiveStateParams): { sql: string; values: unknown[] } {
  const activityFilter = params.activityId ? "and te.activity_id = $4" : "";
  const values: unknown[] = [params.rangeStart, params.rangeEnd, params.landId];
  if (params.activityId) values.push(params.activityId);

  const sql = `
    select gl.id, gl.name, gl.north_south_feet, gl.east_west_feet, gl.is_active,
      coalesce(json_agg(json_build_object(
        'id', gp.id, 'name', gp.name, 'description', gp.description,
        'northSouthFeet', gp.north_south_feet, 'eastWestFeet', gp.east_west_feet,
        'xFeetFromWest', gp.x_feet_from_west, 'yFeetFromNorth', gp.y_feet_from_north,
        'isActive', gp.is_active, 'sortOrder', gp.sort_order,
        'rows', coalesce(rowsub.rows, '[]'::json)
      ) order by gp.sort_order nulls last, gp.name) filter (where gp.id is not null), '[]'::json) as phases
    from greenhouse_lands gl
    left join greenhouse_phases gp on gp.land_id = gl.id and gp.is_active = true
    left join lateral (
      select json_agg(json_build_object(
        'id', gr.id, 'rowNumber', gr.row_number, 'xFt', gr.x_ft, 'yFt', gr.y_ft,
        'widthFt', gr.width_ft, 'lengthFt', gr.length_ft, 'orientation', gr.orientation,
        'state', case when os.employees is not null then 'blue'
                      when cs.employees is not null then 'green'
                      else 'neutral' end,
        'employees', coalesce(os.employees, cs.employees, '[]'::json)
      ) order by gr.row_number) as rows
      from greenhouse_rows gr
      -- Exactly one open work entry can ever exist per employee (partial
      -- unique index on time_entries, see 003_activities_and_time_entries.sql
      -- + 010_break_profiles.sql), so this is already at most one row per
      -- employee — no distinct/dedup needed the way the completed-side
      -- query below does.
      left join lateral (
        select json_agg(json_build_object(
          'id', e.id, 'firstName', e.first_name, 'lastName', e.last_name,
          'activityName', a.name, 'startedAt', te.started_at,
          'carrierName', c.name
        )) as employees
        from time_entries te
        join employees e on e.id = te.employee_id
        join activities a on a.id = te.activity_id
        left join carriers c on c.id = te.carrier_id
        where te.greenhouse_row_id = gr.id and te.entry_type = 'work' and te.deleted_at is null
          and te.ended_at is null and te.started_at < $2
          ${activityFilter}
      ) os(employees) on true
      -- An employee can have worked this row more than once in the range —
      -- "distinct on" keeps only each employee's most recent completed
      -- segment (per row/range) for the tooltip's history summary.
      left join lateral (
        select json_agg(json_build_object(
          'id', x.employee_id, 'firstName', x.first_name, 'lastName', x.last_name,
          'activityName', x.activity_name, 'endedAt', x.ended_at,
          'carrierName', x.carrier_name
        )) as employees
        from (
          select distinct on (te.employee_id)
            te.employee_id, e.first_name, e.last_name, a.name as activity_name, te.ended_at, c.name as carrier_name
          from time_entries te
          join employees e on e.id = te.employee_id
          join activities a on a.id = te.activity_id
          left join carriers c on c.id = te.carrier_id
          where te.greenhouse_row_id = gr.id and te.entry_type = 'work' and te.deleted_at is null
            and te.ended_at is not null and te.started_at >= $1 and te.started_at < $2
            ${activityFilter}
          order by te.employee_id, te.ended_at desc
        ) x
      ) cs(employees) on true
      where gr.phase_id = gp.id and gr.deleted_at is null
    ) rowsub on true
    where gl.id = $3
    group by gl.id
  `;

  return { sql, values };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeLiveLand(row: any) {
  return {
    id: row.id,
    name: row.name,
    northSouthFeet: Number(row.north_south_feet),
    eastWestFeet: Number(row.east_west_feet),
    isActive: row.is_active,
    // Every field inside phases/rows was built by json_build_object from
    // already-correctly-typed Postgres values — no further coercion needed,
    // same as greenhouseLayout.ts's serializeLandDetail.
    phases: row.phases,
  };
}

// Applied only by the TV route (GET /display/:displayKey/state in
// greenhouseLive.ts), never by the authenticated office /live route. A
// display token is a bearer credential embedded in a URL — anyone holding
// it can call this JSON endpoint directly, not just view it through the TV
// page's own rendering — so full employee names are redacted to "First L."
// server-side, at the actual security boundary, rather than trusting the
// client to display them differently. Mutates and returns the same object
// serializeLiveLand produced; only ever called on a fresh instance.
export function redactEmployeeNamesForDisplay(
  land: ReturnType<typeof serializeLiveLand>
): ReturnType<typeof serializeLiveLand> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const phase of land.phases as any[]) {
    for (const row of phase.rows as any[]) {
      for (const employee of row.employees as any[]) {
        if (typeof employee.lastName === "string" && employee.lastName.length > 0) {
          employee.lastName = `${employee.lastName.charAt(0)}.`;
        }
      }
    }
  }
  return land;
}
