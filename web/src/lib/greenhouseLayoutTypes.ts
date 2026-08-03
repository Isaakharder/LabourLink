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
