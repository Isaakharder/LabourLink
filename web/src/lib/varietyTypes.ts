// Basic Data -> Varieties (server/src/routes/varieties.ts).

export interface GrowingSeason {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string | null;
  isCurrent: boolean;
  assignedRows: number;
}

export interface VarietySummary {
  rows: number;
  // Rows assigned this season that have since been deleted from the
  // layout: kept as history, not counted in the totals.
  deletedRows: number;
  totalLengthM: number;
  // Calculated from plants planted and saved row lengths.
  plantsPerMetre: number | null;
  averageEstimatedPlantsPerRow: number | null;
  // Entered Plant Density "Plants per row" settings on these rows.
  rowsWithEnteredCount: number;
  enteredPlantsTotal: number | null;
}

export interface Variety {
  id: string;
  name: string;
  notes: string | null;
  isActive: boolean;
  inUse: boolean;
  plantedThisSeason: boolean;
  totalPlants: number | null;
  summary: VarietySummary;
}

export interface SeasonRow {
  id: string;
  landName: string;
  phaseId: string;
  phaseName: string;
  rowNumber: number;
  lengthFt: number;
  deleted: boolean;
  varietyId: string | null;
  enteredPlantsPerRow: number | null;
}

export interface VarietyRowDetail {
  id: string;
  landName: string;
  phaseName: string;
  rowNumber: number;
  lengthM: number;
  deleted: boolean;
  estimatedPlants: number | null;
  enteredPlantsPerRow: number | null;
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
export function formatNumber(n: number | null | undefined, digits = 2): string {
  if (n == null) return "—";
  return digits === 2 ? numberFormat.format(n) : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
}

export function formatSeasonDates(s: Pick<GrowingSeason, "startsOn" | "endsOn">): string {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${f(s.startsOn)} – ${s.endsOn ? f(s.endsOn) : "ongoing"}`;
}

// Stable colours for the row grid, by the variety's position in the list.
export const VARIETY_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#ea580c", "#4f46e5"];
