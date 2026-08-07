// DTOs for /api/plant-densities — server/src/routes/plantDensities.ts.

export type PlantDensityType = "plants" | "stems";

export interface PlantDensityLinkedRow {
  id: string;
  rowNumber: number;
  phaseName: string;
}

export interface PlantDensitySummary {
  id: string;
  name: string;
  type: PlantDensityType;
  countPerRow: number;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlantDensityDetail extends PlantDensitySummary {
  rows: PlantDensityLinkedRow[];
}

// One entry per currently-linked row, across every density of a given
// type — GET /api/plant-densities/row-links?type=plants|stems. Used only
// by the Link Rows map to know which rows already belong to a density of
// the *same* type (a row having both a Plants and a Stems density
// simultaneously is normal, not a conflict), so it can highlight them and
// confirm before reassigning. Entirely independent of Employee Blocks'
// equivalent row-links.
export interface PlantDensityRowLink {
  greenhouseRowId: string;
  densityId: string;
  densityType: PlantDensityType;
  densityName: string;
}
