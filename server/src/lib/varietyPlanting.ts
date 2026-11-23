import { Pool, PoolClient } from "pg";

// Variety planting maths (076_varieties.sql). Pure functions plus one
// history lookup. Everything here is CALCULATED from a variety's total
// plants planted and the rows' saved lengths; none of it is a counted
// per-row value. The entered per-row "Plants per row" settings live in
// plant_densities and are reported separately.

export const METRES_PER_FOOT = 0.3048;

export interface RowLength {
  id: string;
  lengthFt: number;
}

export interface VarietyPlantingSummary {
  rows: number;
  totalLengthFt: number;
  totalLengthM: number;
  totalPlants: number | null;
  // Calculated: totalPlants / totalLengthM. Null without plants or rows.
  plantsPerMetre: number | null;
  // Calculated: totalPlants / rows (the average of the per-row estimates).
  averageEstimatedPlantsPerRow: number | null;
}

export function summarizePlanting(totalPlants: number | null, rows: RowLength[]): VarietyPlantingSummary {
  const totalLengthFt = rows.reduce((s, r) => s + r.lengthFt, 0);
  const totalLengthM = totalLengthFt * METRES_PER_FOOT;
  const usable = totalPlants != null && totalPlants > 0 && rows.length > 0 && totalLengthM > 0;
  return {
    rows: rows.length,
    totalLengthFt,
    totalLengthM,
    totalPlants,
    plantsPerMetre: usable ? totalPlants! / totalLengthM : null,
    averageEstimatedPlantsPerRow: usable ? totalPlants! / rows.length : null,
  };
}

// Splits totalPlants across rows in proportion to their saved length:
// share = totalPlants * rowLength / totalLength. Exact (not rounded), so
// rows of equal length always get equal estimates and the shares add up to
// totalPlants. Empty map without plants or rows.
export function estimatePlantsByLength(totalPlants: number | null, rows: RowLength[]): Map<string, number> {
  const out = new Map<string, number>();
  const totalLength = rows.reduce((s, r) => s + r.lengthFt, 0);
  if (totalPlants == null || totalPlants <= 0 || rows.length === 0 || totalLength <= 0) return out;
  for (const r of rows) out.set(r.id, (totalPlants * r.lengthFt) / totalLength);
  return out;
}

// The variety a row held on a greenhouse-local date: the assignment in the
// season covering that date. Null when no season covers the date or the
// row had no variety then. For the forecasting stage: a past harvest keeps
// the variety planted at the time, whatever the row holds later.
export async function varietyForRowOnDate(
  db: Pool | PoolClient,
  greenhouseRowId: string,
  date: string
): Promise<{ seasonId: string; varietyId: string } | null> {
  const { rows } = await db.query(
    `select a.season_id, a.variety_id
     from variety_row_assignments a
     join growing_seasons s on s.id = a.season_id
     where a.greenhouse_row_id = $1 and s.starts_on <= $2::date and (s.ends_on is null or s.ends_on >= $2::date)`,
    [greenhouseRowId, date]
  );
  return rows[0] ? { seasonId: rows[0].season_id, varietyId: rows[0].variety_id } : null;
}
