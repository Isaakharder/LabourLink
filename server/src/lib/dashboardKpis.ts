import { Pool, PoolClient } from "pg";
import { getDayBoundsUtc } from "./timezone";

// Small read-only figures for the Dashboard's KPI strip. Each KPI is null
// when it does not apply to this greenhouse, so the Dashboard hides the
// card instead of showing a zero that means nothing.

export interface KgWeighedKpi {
  netKg: number;
  bins: number;
  lastWeighedAt: string | null;
}

// Net kilograms weighed on a greenhouse-local calendar date (the same day
// boundaries as the Scale Weighings page). Reads scale_production_weighings,
// the shared definition of a weighing that counts for production: trial and
// live, credited or not, but never voided and never a duplicate. Null when
// the greenhouse has no LabourLink Scale (no active station and nothing
// weighed that day).
export async function getKgWeighedOnDate(db: Pool | PoolClient, date: string): Promise<KgWeighedKpi | null> {
  const { start, end } = getDayBoundsUtc(date);
  const { rows } = await db.query(
    `select exists (select 1 from scale_stations where is_active) as has_station,
            coalesce(sum(p.net_g), 0)::bigint as net_g,
            count(p.id)::int as bins,
            max(p.weighed_at) as last_weighed_at
     from scale_production_weighings p
     where p.weighed_at >= $1 and p.weighed_at < $2`,
    [start, end]
  );
  const r = rows[0];
  if (!r.has_station && r.bins === 0) return null;
  return {
    netKg: Math.round(Number(r.net_g)) / 1000,
    bins: r.bins,
    lastWeighedAt: r.last_weighed_at ? new Date(r.last_weighed_at).toISOString() : null,
  };
}
