import { Router } from "express";
import { PoolClient } from "pg";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { calendarDateInAppTimezone } from "../lib/timezone";
import { estimatePlantsByLength, METRES_PER_FOOT, RowLength, summarizePlanting } from "../lib/varietyPlanting";

// Basic Data -> Varieties (076_varieties.sql): the variety catalogue,
// growing seasons, plants planted per variety per season, and which
// variety each greenhouse row holds in a season. Reading is for
// Administrator/Manager, changes are Administrator only (the same split as
// Plant Density). Display and configuration only: nothing here touches
// time entries, weighings, credits or payroll.

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PLANTS = 100_000_000;

const canRead = requireRole("Administrator", "Manager");
const canWrite = requireRole("Administrator");

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isValidDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Postgres unique violation -> a friendly field error.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

// Postgres exclusion violation: excl_growing_seasons_no_overlap (076) caught
// an overlap the API's own check didn't see (e.g. two requests at once).
function isSeasonOverlapViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23P01" &&
    (err as { constraint?: string }).constraint === "excl_growing_seasons_no_overlap"
  );
}

const SEASON_OVERLAP_ERROR = { errors: { startsOn: "These dates overlap another growing season" } };

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeSeason(r: any, today: string) {
  return {
    id: r.id,
    name: r.name,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    isCurrent: r.starts_on <= today && (r.ends_on === null || r.ends_on >= today),
    assignedRows: Number(r.assigned_rows ?? 0),
  };
}

const SEASON_SELECT = `
  select s.id, s.name, to_char(s.starts_on, 'YYYY-MM-DD') as starts_on, to_char(s.ends_on, 'YYYY-MM-DD') as ends_on,
         (select count(*) from variety_row_assignments a where a.season_id = s.id) as assigned_rows
  from growing_seasons s`;

async function loadSeasons(client: { query: PoolClient["query"] } = pool) {
  const today = calendarDateInAppTimezone(new Date());
  const { rows } = await client.query(`${SEASON_SELECT} order by s.starts_on desc`);
  return rows.map((r) => serializeSeason(r, today));
}

// The season covering today, else the latest one that has started, else
// the earliest upcoming one.
function defaultSeasonId(seasons: ReturnType<typeof serializeSeason>[]): string | null {
  const today = calendarDateInAppTimezone(new Date());
  return (
    seasons.find((s) => s.isCurrent)?.id ??
    seasons.find((s) => s.startsOn <= today)?.id ??
    [...seasons].sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0]?.id ??
    null
  );
}

interface SeasonInput {
  name: string;
  startsOn: string;
  endsOn: string | null;
}

function parseSeasonInput(body: Record<string, unknown>, existing?: SeasonInput): { value?: SeasonInput; errors?: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = "name" in body || !existing ? trimOrNull(body.name) : existing.name;
  if (!name) errors.name = "Season name is required";
  const startsOn = "startsOn" in body || !existing ? body.startsOn : existing.startsOn;
  if (!isValidDate(startsOn)) errors.startsOn = "Start date is required";
  let endsOn: string | null = existing ? existing.endsOn : null;
  if ("endsOn" in body) {
    if (body.endsOn === null || body.endsOn === "") endsOn = null;
    else if (isValidDate(body.endsOn)) endsOn = body.endsOn;
    else errors.endsOn = "End date must be a valid date";
  }
  if (!errors.startsOn && !errors.endsOn && endsOn !== null && endsOn < (startsOn as string)) errors.endsOn = "End date can't be before the start date";
  if (Object.keys(errors).length) return { errors };
  return { value: { name: name!, startsOn: startsOn as string, endsOn } };
}

// Seasons never overlap, so every date belongs to at most one season (and
// so to at most one variety per row). The database enforces it
// (excl_growing_seasons_no_overlap, 076). Season writes from the API also
// queue behind one transaction-level advisory lock: without it, two
// simultaneous overlapping requests can deadlock inside the exclusion
// constraint (one would get a server error instead of a clear message).
// Reads are never blocked. This check then finds which season is in the
// way so the error can name it.
async function findOverlap(client: PoolClient, input: SeasonInput, exceptId: string | null) {
  await client.query("select pg_advisory_xact_lock(hashtext('labourlink.growing_seasons'))");
  const { rows } = await client.query(
    `select name from growing_seasons
     where ($3::uuid is null or id <> $3)
       and starts_on <= coalesce($2::date, 'infinity'::date)
       and coalesce(ends_on, 'infinity'::date) >= $1::date
     limit 1`,
    [input.startsOn, input.endsOn, exceptId]
  );
  return rows[0]?.name as string | undefined;
}

router.get(
  "/seasons",
  canRead,
  asyncHandler(async (_req, res) => {
    const seasons = await loadSeasons();
    res.json({ seasons, defaultSeasonId: defaultSeasonId(seasons) });
  })
);

// Optional copyFromSeasonId copies that season's plantings (with their
// plant totals) and row assignments into the new season, as a starting
// point for the next planting; the source season is never changed.
router.post(
  "/seasons",
  canWrite,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const parsed = parseSeasonInput(body);
    if (parsed.errors) return res.status(400).json({ errors: parsed.errors });
    const input = parsed.value!;
    const copyFrom = body.copyFromSeasonId ?? null;
    if (copyFrom !== null && !(typeof copyFrom === "string" && UUID_RE.test(copyFrom))) {
      return res.status(400).json({ errors: { copyFromSeasonId: "Unknown season to copy from" } });
    }

    try {
      const result = await inTransaction(async (client) => {
        const overlap = await findOverlap(client, input, null);
        if (overlap) return { status: 409, body: { errors: { startsOn: `These dates overlap the season "${overlap}"` } } };
        if (copyFrom) {
          const src = await client.query("select id from growing_seasons where id = $1", [copyFrom]);
          if (!src.rows[0]) return { status: 400, body: { errors: { copyFromSeasonId: "Unknown season to copy from" } } };
        }
        const { rows } = await client.query(`insert into growing_seasons (name, starts_on, ends_on) values ($1, $2, $3) returning id`, [
          input.name,
          input.startsOn,
          input.endsOn,
        ]);
        const id = rows[0].id as string;
        if (copyFrom) {
          await client.query(
            `insert into variety_plantings (season_id, variety_id, total_plants)
             select $1, variety_id, total_plants from variety_plantings where season_id = $2`,
            [id, copyFrom]
          );
          await client.query(
            // The new season's length snapshot is the layout as it is now
            // (the season being planted), not the source season's lengths.
            `insert into variety_row_assignments (season_id, greenhouse_row_id, variety_id, row_length_ft)
             select $1, a.greenhouse_row_id, a.variety_id, gr.length_ft
             from variety_row_assignments a join greenhouse_rows gr on gr.id = a.greenhouse_row_id
             where a.season_id = $2 and gr.deleted_at is null`,
            [id, copyFrom]
          );
        }
        return { status: 201, body: { seasonId: id } };
      });
      if (result.status !== 201) return res.status(result.status).json(result.body);
      const seasons = await loadSeasons();
      res.status(201).json({ season: seasons.find((s) => s.id === result.body.seasonId), seasons });
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ errors: { name: "A season with this name already exists" } });
      if (isSeasonOverlapViolation(err)) return res.status(409).json(SEASON_OVERLAP_ERROR);
      throw err;
    }
  })
);

router.patch(
  "/seasons/:id",
  canWrite,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid season id" });
    try {
      const result = await inTransaction(async (client) => {
        const cur = await client.query(
          `select name, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on from growing_seasons where id = $1 for update`,
          [id]
        );
        if (!cur.rows[0]) return { status: 404, body: { error: "Season not found" } };
        const parsed = parseSeasonInput(req.body ?? {}, { name: cur.rows[0].name, startsOn: cur.rows[0].starts_on, endsOn: cur.rows[0].ends_on });
        if (parsed.errors) return { status: 400, body: { errors: parsed.errors } };
        const overlap = await findOverlap(client, parsed.value!, id);
        if (overlap) return { status: 409, body: { errors: { startsOn: `These dates overlap the season "${overlap}"` } } };
        await client.query(`update growing_seasons set name = $2, starts_on = $3, ends_on = $4, updated_at = now() where id = $1`, [
          id,
          parsed.value!.name,
          parsed.value!.startsOn,
          parsed.value!.endsOn,
        ]);
        return { status: 200, body: {} };
      });
      if (result.status !== 200) return res.status(result.status).json(result.body);
      const seasons = await loadSeasons();
      res.json({ season: seasons.find((s) => s.id === id), seasons });
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ errors: { name: "A season with this name already exists" } });
      if (isSeasonOverlapViolation(err)) return res.status(409).json(SEASON_OVERLAP_ERROR);
      throw err;
    }
  })
);

// Only a season with no row assignments can be deleted (its plant totals
// go with it). A season that recorded where varieties were planted is
// history and stays.
router.delete(
  "/seasons/:id",
  canWrite,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid season id" });
    const result = await inTransaction(async (client) => {
      const cur = await client.query("select id from growing_seasons where id = $1 for update", [id]);
      if (!cur.rows[0]) return 404;
      const used = await client.query("select 1 from variety_row_assignments where season_id = $1 limit 1", [id]);
      if (used.rows[0]) return 409;
      await client.query("delete from variety_plantings where season_id = $1", [id]);
      await client.query("delete from growing_seasons where id = $1", [id]);
      return 200;
    });
    if (result === 404) return res.status(404).json({ error: "Season not found" });
    if (result === 409) return res.status(409).json({ error: "This season has rows assigned to varieties. Unassign them first, or keep the season as history." });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Rows for a season (the assignment grid)
// ---------------------------------------------------------------------------

interface SeasonRow {
  id: string;
  landName: string;
  phaseId: string;
  phaseName: string;
  rowNumber: number;
  // The season's length for this row: its snapshot when assigned, else
  // (unassigned) the current layout length.
  lengthFt: number;
  // The row's length in the current layout (null if removed from it).
  layoutLengthFt: number | null;
  // Assigned, and the layout length no longer matches the snapshot.
  lengthChanged: boolean;
  varietyId: string | null;
  enteredPlantsPerRow: number | null;
}

// Every current (not deleted) row in an active phase and land, plus any
// row assigned in this season even if it has since been removed from the
// layout (kept, flagged: it was planted that season). enteredPlantsPerRow
// is the existing Plant Density "Plants per row" setting, if any.
async function loadSeasonRows(seasonId: string): Promise<(SeasonRow & { deleted: boolean })[]> {
  const { rows } = await pool.query(
    `select gr.id, gl.name as land_name, gp.id as phase_id, gp.name as phase_name, gr.row_number, gr.length_ft,
            a.row_length_ft, gr.deleted_at is not null as deleted, a.variety_id, pd.count_per_row as entered_plants_per_row
     from greenhouse_rows gr
     join greenhouse_phases gp on gp.id = gr.phase_id
     join greenhouse_lands gl on gl.id = gp.land_id
     left join variety_row_assignments a on a.greenhouse_row_id = gr.id and a.season_id = $1
     left join plant_density_rows pdr on pdr.greenhouse_row_id = gr.id and pdr.density_type = 'plants'
     left join plant_densities pd on pd.id = pdr.density_id
     where (gr.deleted_at is null and gp.is_active and gl.is_active) or a.variety_id is not null
     order by gl.name, gp.name, gr.row_number`,
    [seasonId]
  );
  return rows.map((r) => ({
    id: r.id,
    landName: r.land_name,
    phaseId: r.phase_id,
    phaseName: r.phase_name,
    rowNumber: r.row_number,
    lengthFt: Number(r.row_length_ft ?? r.length_ft),
    layoutLengthFt: r.deleted ? null : Number(r.length_ft),
    lengthChanged: r.row_length_ft != null && !r.deleted && Number(r.row_length_ft) !== Number(r.length_ft),
    deleted: r.deleted,
    varietyId: r.variety_id,
    enteredPlantsPerRow: r.entered_plants_per_row == null ? null : Number(r.entered_plants_per_row),
  }));
}

async function seasonExists(id: string): Promise<boolean> {
  return (await pool.query("select 1 from growing_seasons where id = $1", [id])).rows.length > 0;
}

function seasonParam(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

router.get(
  "/rows",
  canRead,
  asyncHandler(async (req, res) => {
    const seasonId = seasonParam(req.query.seasonId);
    if (!seasonId) return res.status(400).json({ error: "seasonId is required" });
    if (!(await seasonExists(seasonId))) return res.status(404).json({ error: "Season not found" });
    res.json({ rows: await loadSeasonRows(seasonId) });
  })
);

// Assigns rowIds to varietyId in a season (replacing any other variety
// those rows held in THIS season), or unassigns them with varietyId null.
// Other seasons are never touched. Creates the variety's planting for the
// season if it doesn't have one yet (plants planted left empty).
router.put(
  "/seasons/:seasonId/rows",
  canWrite,
  asyncHandler(async (req, res) => {
    const seasonId = seasonParam(req.params.seasonId);
    if (!seasonId) return res.status(400).json({ error: "Invalid season id" });
    const rowIds = req.body?.rowIds;
    const varietyId = req.body?.varietyId ?? null;
    if (!Array.isArray(rowIds) || rowIds.length === 0 || rowIds.length > 5000 || !rowIds.every((r) => typeof r === "string" && UUID_RE.test(r))) {
      return res.status(400).json({ error: "rowIds must be a non-empty list of row ids" });
    }
    if (varietyId !== null && !(typeof varietyId === "string" && UUID_RE.test(varietyId))) {
      return res.status(400).json({ error: "Invalid variety id" });
    }
    const ids = [...new Set(rowIds as string[])];

    const result = await inTransaction(async (client) => {
      const season = await client.query("select id from growing_seasons where id = $1 for update", [seasonId]);
      if (!season.rows[0]) return { status: 404, error: "Season not found" };
      if (varietyId) {
        const v = await client.query("select is_active from varieties where id = $1", [varietyId]);
        if (!v.rows[0]) return { status: 404, error: "Variety not found" };
        if (!v.rows[0].is_active) return { status: 409, error: "This variety is inactive. Reactivate it before assigning rows." };
        const found = await client.query("select id from greenhouse_rows where id = any($1::uuid[]) and deleted_at is null", [ids]);
        if (found.rows.length !== ids.length) return { status: 400, error: "One or more rows were not found" };
        await client.query(
          `insert into variety_plantings (season_id, variety_id) values ($1, $2) on conflict (season_id, variety_id) do nothing`,
          [seasonId, varietyId]
        );
        await client.query(
          // A newly assigned row saves its current layout length as the
          // season's snapshot. Moving a row to another variety in the same
          // season keeps the snapshot it already has.
          `insert into variety_row_assignments (season_id, greenhouse_row_id, variety_id, row_length_ft)
           select $1, gr.id, $3, gr.length_ft from greenhouse_rows gr where gr.id = any($2::uuid[])
           on conflict (season_id, greenhouse_row_id) do update set variety_id = excluded.variety_id, assigned_at = now()
           where variety_row_assignments.variety_id is distinct from excluded.variety_id`,
          [seasonId, ids, varietyId]
        );
      } else {
        await client.query("delete from variety_row_assignments where season_id = $1 and greenhouse_row_id = any($2::uuid[])", [seasonId, ids]);
      }
      return { status: 200 };
    });
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.json({ rows: await loadSeasonRows(seasonId) });
  })
);

// "Use current layout lengths": the only way a season's saved row lengths
// change (e.g. after fixing a row that was drawn the wrong length). Rows
// removed from the layout keep their snapshot.
//
// Two steps, Administrator only. The preview says which season and exactly
// how many rows would change (with examples); the update must repeat that
// season's name and row count, and is refused if either no longer matches
// (renamed season, layout changed again, another admin already updated),
// so a confirmation can never change more or other rows than it showed.
const LAYOUT_LENGTH_CHANGES = `
  select a.greenhouse_row_id, gp.name as phase_name, gr.row_number, a.row_length_ft, gr.length_ft
  from variety_row_assignments a
  join greenhouse_rows gr on gr.id = a.greenhouse_row_id
  join greenhouse_phases gp on gp.id = gr.phase_id
  where a.season_id = $1 and gr.deleted_at is null and a.row_length_ft <> gr.length_ft
  order by gp.name, gr.row_number`;

router.get(
  "/seasons/:seasonId/layout-length-changes",
  canWrite,
  asyncHandler(async (req, res) => {
    const seasonId = seasonParam(req.params.seasonId);
    if (!seasonId) return res.status(400).json({ error: "Invalid season id" });
    const season = await pool.query("select id, name from growing_seasons where id = $1", [seasonId]);
    if (!season.rows[0]) return res.status(404).json({ error: "Season not found" });
    const { rows } = await pool.query(LAYOUT_LENGTH_CHANGES, [seasonId]);
    res.json({
      season: { id: season.rows[0].id, name: season.rows[0].name },
      affectedRows: rows.length,
      examples: rows.slice(0, 10).map((r) => ({
        phaseName: r.phase_name,
        rowNumber: r.row_number,
        savedLengthM: round(Number(r.row_length_ft) * METRES_PER_FOOT, 1),
        layoutLengthM: round(Number(r.length_ft) * METRES_PER_FOOT, 1),
      })),
    });
  })
);

router.post(
  "/seasons/:seasonId/use-layout-lengths",
  canWrite,
  asyncHandler(async (req, res) => {
    const seasonId = seasonParam(req.params.seasonId);
    if (!seasonId) return res.status(400).json({ error: "Invalid season id" });
    const confirmName = req.body?.confirmSeasonName;
    const confirmRows = req.body?.confirmAffectedRows;
    if (typeof confirmName !== "string" || !Number.isInteger(confirmRows) || confirmRows < 1) {
      return res.status(400).json({ error: "Confirm the season name and the number of rows to update" });
    }

    const result = await inTransaction(async (client) => {
      const season = await client.query("select name from growing_seasons where id = $1 for update", [seasonId]);
      if (!season.rows[0]) return { status: 404, body: { error: "Season not found" } };
      // Lock the season's assignment rows so the count can't change between
      // the check and the update.
      await client.query("select 1 from variety_row_assignments where season_id = $1 for update", [seasonId]);
      const changes = await client.query(LAYOUT_LENGTH_CHANGES, [seasonId]);
      if (season.rows[0].name !== confirmName || changes.rows.length !== confirmRows) {
        return {
          status: 409,
          body: {
            error: `The confirmation no longer matches: ${season.rows[0].name} now has ${changes.rows.length} row${
              changes.rows.length === 1 ? "" : "s"
            } to update. Nothing was changed; review and confirm again.`,
            seasonName: season.rows[0].name,
            affectedRows: changes.rows.length,
          },
        };
      }
      const { rowCount } = await client.query(
        `update variety_row_assignments a set row_length_ft = gr.length_ft, length_saved_at = now()
         from greenhouse_rows gr
         where a.season_id = $1 and gr.id = a.greenhouse_row_id and gr.deleted_at is null and a.row_length_ft <> gr.length_ft`,
        [seasonId]
      );
      return { status: 200, body: { updated: rowCount ?? 0 } };
    });
    if (result.status !== 200) return res.status(result.status).json(result.body);
    res.json({ ...result.body, rows: await loadSeasonRows(seasonId) });
  })
);

// ---------------------------------------------------------------------------
// Varieties
// ---------------------------------------------------------------------------

interface VarietyRecord {
  id: string;
  name: string;
  notes: string | null;
  isActive: boolean;
}

async function loadVarietiesForSeason(seasonId: string | null) {
  const { rows: varieties } = await pool.query(`select id, name, notes, is_active from varieties order by is_active desc, lower(name)`);
  const plantings = seasonId
    ? (await pool.query(`select variety_id, total_plants from variety_plantings where season_id = $1`, [seasonId])).rows
    : [];
  const rows = seasonId ? await loadSeasonRows(seasonId) : [];
  const usedAnywhere = new Set(
    (await pool.query(`select distinct variety_id from variety_plantings`)).rows.map((r) => r.variety_id as string)
  );

  return varieties.map((v) => {
    const planting = plantings.find((p) => p.variety_id === v.id);
    const totalPlants = planting?.total_plants == null ? null : Number(planting.total_plants);
    // Every row planted with this variety in the season, at the season's
    // saved lengths: later layout changes don't move these figures.
    const assigned = rows.filter((r) => r.varietyId === v.id);
    const summary = summarizePlanting(totalPlants, assigned);
    const withEntered = assigned.filter((r) => r.enteredPlantsPerRow != null);
    return {
      id: v.id,
      name: v.name,
      notes: v.notes,
      isActive: v.is_active,
      inUse: usedAnywhere.has(v.id),
      plantedThisSeason: Boolean(planting),
      totalPlants,
      summary: {
        rows: summary.rows,
        deletedRows: assigned.filter((r) => r.deleted).length,
        lengthChangedRows: assigned.filter((r) => r.lengthChanged).length,
        totalLengthM: round(summary.totalLengthM, 1),
        plantsPerMetre: summary.plantsPerMetre == null ? null : round(summary.plantsPerMetre, 2),
        averageEstimatedPlantsPerRow: summary.averageEstimatedPlantsPerRow == null ? null : round(summary.averageEstimatedPlantsPerRow, 1),
        rowsWithEnteredCount: withEntered.length,
        enteredPlantsTotal: withEntered.length ? withEntered.reduce((s, r) => s + r.enteredPlantsPerRow!, 0) : null,
      },
    };
  });
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function parseTotalPlants(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_PLANTS) return { ok: false };
  return { ok: true, value: n };
}

router.get(
  "/",
  canRead,
  asyncHandler(async (req, res) => {
    let seasonId = seasonParam(req.query.seasonId);
    if (req.query.seasonId !== undefined && !seasonId) return res.status(400).json({ error: "Invalid season id" });
    if (seasonId && !(await seasonExists(seasonId))) return res.status(404).json({ error: "Season not found" });
    if (!seasonId) seasonId = defaultSeasonId(await loadSeasons());
    res.json({ seasonId, varieties: await loadVarietiesForSeason(seasonId) });
  })
);

function parseVarietyInput(body: Record<string, unknown>, partial: boolean): { value: Partial<VarietyRecord>; errors?: Record<string, string> } {
  const errors: Record<string, string> = {};
  const value: Partial<VarietyRecord> = {};
  if (!partial || "name" in body) {
    const name = trimOrNull(body.name);
    if (!name) errors.name = "Variety name is required";
    else if (name.length > 120) errors.name = "Keep the name under 120 characters";
    else value.name = name;
  }
  if ("notes" in body) {
    if (body.notes !== null && typeof body.notes !== "string") errors.notes = "Notes must be text";
    else value.notes = trimOrNull(body.notes);
  }
  if ("isActive" in body) {
    if (typeof body.isActive !== "boolean") errors.isActive = "isActive must be true or false";
    else value.isActive = body.isActive;
  }
  return Object.keys(errors).length ? { value, errors } : { value };
}

// Optional seasonId + totalPlants records plants planted in that season
// in the same request (used by the Add/Edit variety form).
async function savePlanting(client: PoolClient, varietyId: string, body: Record<string, unknown>): Promise<string | null> {
  if (!("totalPlants" in body)) return null;
  const seasonId = seasonParam(body.seasonId);
  if (!seasonId) return "Choose a season to record plants planted";
  const parsed = parseTotalPlants(body.totalPlants);
  if (!parsed.ok) return "Plants planted must be a whole number greater than 0";
  const season = await client.query("select 1 from growing_seasons where id = $1", [seasonId]);
  if (!season.rows[0]) return "Season not found";
  if (parsed.value === null) {
    await client.query(`update variety_plantings set total_plants = null, updated_at = now() where season_id = $1 and variety_id = $2`, [seasonId, varietyId]);
  } else {
    await client.query(
      `insert into variety_plantings (season_id, variety_id, total_plants) values ($1, $2, $3)
       on conflict (season_id, variety_id) do update set total_plants = excluded.total_plants, updated_at = now()`,
      [seasonId, varietyId, parsed.value]
    );
  }
  return null;
}

router.post(
  "/",
  canWrite,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const { value, errors } = parseVarietyInput(body, false);
    if (errors) return res.status(400).json({ errors });
    try {
      const result = await inTransaction(async (client) => {
        const { rows } = await client.query(`insert into varieties (name, notes) values ($1, $2) returning id`, [value.name, value.notes ?? null]);
        const plantingError = await savePlanting(client, rows[0].id, body);
        if (plantingError) throw Object.assign(new Error(plantingError), { fieldError: { totalPlants: plantingError } });
        return rows[0].id as string;
      });
      res.status(201).json({ id: result });
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ errors: { name: "A variety with this name already exists" } });
      if ((err as { fieldError?: unknown }).fieldError) return res.status(400).json({ errors: (err as { fieldError: unknown }).fieldError });
      throw err;
    }
  })
);

router.patch(
  "/:id",
  canWrite,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid variety id" });
    const body = req.body ?? {};
    const { value, errors } = parseVarietyInput(body, true);
    if (errors) return res.status(400).json({ errors });
    try {
      const result = await inTransaction(async (client) => {
        const cur = await client.query("select id from varieties where id = $1 for update", [id]);
        if (!cur.rows[0]) return 404;
        const sets: string[] = [];
        const vals: unknown[] = [id];
        if (value.name !== undefined) sets.push(`name = $${vals.push(value.name)}`);
        if ("notes" in value) sets.push(`notes = $${vals.push(value.notes)}`);
        if (value.isActive !== undefined) sets.push(`is_active = $${vals.push(value.isActive)}`);
        if (sets.length) await client.query(`update varieties set ${sets.join(", ")}, updated_at = now() where id = $1`, vals);
        const plantingError = await savePlanting(client, id, body);
        if (plantingError) throw Object.assign(new Error(plantingError), { fieldError: { totalPlants: plantingError } });
        return 200;
      });
      if (result === 404) return res.status(404).json({ error: "Variety not found" });
      res.json({ ok: true });
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ errors: { name: "A variety with this name already exists" } });
      if ((err as { fieldError?: unknown }).fieldError) return res.status(400).json({ errors: (err as { fieldError: unknown }).fieldError });
      throw err;
    }
  })
);

// Only a variety that was never planted in any season can be deleted;
// otherwise deactivate it so its history stays intact.
router.delete(
  "/:id",
  canWrite,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid variety id" });
    const result = await inTransaction(async (client) => {
      const cur = await client.query("select id from varieties where id = $1 for update", [id]);
      if (!cur.rows[0]) return 404;
      const used = await client.query("select 1 from variety_plantings where variety_id = $1 limit 1", [id]);
      if (used.rows[0]) return 409;
      await client.query("delete from varieties where id = $1", [id]);
      return 200;
    });
    if (result === 404) return res.status(404).json({ error: "Variety not found" });
    if (result === 409) return res.status(409).json({ error: "This variety has been planted in a season. Deactivate it instead so its history is kept." });
    res.json({ ok: true });
  })
);

// Per-row breakdown for one variety in one season: each row's saved length
// and its CALCULATED share of the plants planted (proportional to length,
// to one decimal), next to the row's entered Plant
// Density "Plants per row" setting where there is one.
router.get(
  "/:id/rows",
  canRead,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid variety id" });
    const seasonId = seasonParam(req.query.seasonId);
    if (!seasonId) return res.status(400).json({ error: "seasonId is required" });
    const v = await pool.query("select id from varieties where id = $1", [id]);
    if (!v.rows[0]) return res.status(404).json({ error: "Variety not found" });
    if (!(await seasonExists(seasonId))) return res.status(404).json({ error: "Season not found" });

    const planting = await pool.query("select total_plants from variety_plantings where season_id = $1 and variety_id = $2", [seasonId, id]);
    const totalPlants = planting.rows[0]?.total_plants == null ? null : Number(planting.rows[0].total_plants);
    const assigned = (await loadSeasonRows(seasonId)).filter((r) => r.varietyId === id);
    const lengths: RowLength[] = assigned.map((r) => ({ id: r.id, lengthFt: r.lengthFt }));
    const estimates = estimatePlantsByLength(totalPlants, lengths);

    res.json({
      totalPlants,
      rows: assigned.map((r) => ({
        id: r.id,
        landName: r.landName,
        phaseName: r.phaseName,
        rowNumber: r.rowNumber,
        lengthM: round(r.lengthFt * METRES_PER_FOOT, 1),
        layoutLengthM: r.layoutLengthFt == null ? null : round(r.layoutLengthFt * METRES_PER_FOOT, 1),
        lengthChanged: r.lengthChanged,
        deleted: r.deleted,
        estimatedPlants: estimates.has(r.id) ? round(estimates.get(r.id)!, 1) : null,
        enteredPlantsPerRow: r.enteredPlantsPerRow,
      })),
    });
  })
);

export default router;
