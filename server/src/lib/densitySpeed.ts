// Ratio-of-sums aggregation for density-based activity speed (see
// 025_activity_density_speed.sql). Deliberately takes a flat list of
// contributions rather than baking in "one day" — the caller decides the
// time window. Inputs (server/src/routes/inputs.ts) calls this once per
// employee+activity+date with that day's contributions; a future weekly
// speed feature must call this same function with a week's worth of
// contributions rather than averaging several daily speed values, so that
// widening the window never changes the underlying math.
export interface DensityContribution {
  quantityPerRow: number;
  durationSeconds: number;
}

export function aggregateDensitySpeed(contributions: DensityContribution[]): number | null {
  if (contributions.length === 0) return null;
  const totalQuantity = contributions.reduce((sum, c) => sum + c.quantityPerRow, 0);
  const totalDurationSeconds = contributions.reduce((sum, c) => sum + c.durationSeconds, 0);
  if (totalDurationSeconds <= 0) return null;
  return totalQuantity / (totalDurationSeconds / 3600);
}
