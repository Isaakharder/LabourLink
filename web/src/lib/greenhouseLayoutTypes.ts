export interface GreenhousePhase {
  id: string;
  landId: string;
  name: string;
  description: string | null;
  northSouthFeet: number;
  eastWestFeet: number;
  xFeetFromWest: number;
  yFeetFromNorth: number;
  isActive: boolean;
  sortOrder: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface GreenhouseLand {
  id: string;
  name: string;
  northSouthFeet: number;
  eastWestFeet: number;
  isActive: boolean;
  phases: GreenhousePhase[];
  createdAt: string;
  updatedAt: string;
}

export interface GreenhouseLandListItem {
  id: string;
  name: string;
  northSouthFeet: number;
  eastWestFeet: number;
  isActive: boolean;
  phaseCount: number;
  createdAt: string;
  updatedAt: string;
}

// A phase position while being dragged/edited client-side, before Save
// Layout persists it.
export interface PhaseDraftPosition {
  id: string;
  xFeetFromWest: number;
  yFeetFromNorth: number;
}

// Persisted final row geometry — x/y are relative to the owning phase's own
// north-west corner (see server/src/lib/rowLayout.ts), not land-absolute.
export interface GreenhouseRow {
  id: string;
  phaseId: string;
  rowBatchId: string | null;
  rowNumber: number;
  xFt: number;
  yFt: number;
  widthFt: number;
  lengthFt: number;
  orientation: "horizontal" | "vertical";
  createdAt: string;
  updatedAt: string;
}

// Row as it appears in the Base Data > Rows flat listing — the same
// GreenhouseRow fields plus the phase/batch context that listing needs and
// a per-phase detail fetch doesn't.
export interface GreenhouseRowListItem extends GreenhouseRow {
  phaseName: string;
  batchName: string | null;
  startSide: "north" | "south" | "east" | "west" | null;
  anchorSide: "north" | "south" | "east" | "west" | null;
  isActive: boolean;
}

export interface GreenhouseRowBatch {
  id: string;
  phaseId: string;
  name: string | null;
  startSide: "north" | "south" | "east" | "west";
  anchorSide: "north" | "south" | "east" | "west";
  rowWidthFt: number;
  rowLengthFt: number;
  rowGapFt: number;
  offsetFt: number;
  numberingMode: "all" | "odd" | "even";
  startRowNumber: number;
  endRowNumber: number;
  continuationMode: string | null;
  createdAt: string;
  updatedAt: string;
}
