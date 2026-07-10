import { apiFetch } from '@/lib/apiClient';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GreenhouseMapListItem {
  id: number;
  siteId: number;
  siteName: string;
  name: string;
  compartmentCount: number;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
}

export type CompassSide = 'north' | 'south' | 'east' | 'west';
export type RowOrientation = 'north_south' | 'east_west';
export type PlacementMode = 'edge' | 'continue' | 'custom_offset';
export type WalkwayOffsetSide = 'north' | 'east' | 'south' | 'west' | 'centered';
export type FilterMode = 'all' | 'odd' | 'even';
export type AlongWallStart = 'near' | 'far' | 'centered' | 'custom';

export interface GreenhouseRowDetail {
  id: number;
  rowNumber: number;
  side: CompassSide;
  widthFt: number;
  lengthFt: number;
  /** Fixed top-left x coordinate (absolute, never changes after creation). */
  xFt: number;
  /** Fixed top-left y coordinate (absolute, never changes after creation). */
  yFt: number;
  orientation: RowOrientation;
  sortOrder: number;
  locationId: number | null;
  locationCode: string | null;
}

export interface GreenhouseRowBlock {
  id: number;
  compartmentId?: number;
  orientation: RowOrientation;
  anchorSide: CompassSide;
  placementMode: PlacementMode;
  offsetFt: number;
  rowWidthFt: number;
  rowLengthFt: number;
  rowSpacingFt: number;
  alongWallStart: AlongWallStart;
  alongWallOffsetFt: number;
  rows: GreenhouseRowDetail[];
}

export interface GreenhouseWalkway {
  id: number;
  label: string | null;
  orientation: RowOrientation;
  widthFt: number;
  offsetFromSide: WalkwayOffsetSide;
  offsetFt: number;
  xFt: number;
  yFt: number;
}

export interface GreenhouseCompartmentDetail {
  id: number;
  name: string;
  eastWestFt: number;
  northSouthFt: number;
  xFt: number;
  yFt: number;
  sortOrder: number;
  blocks: GreenhouseRowBlock[];
  walkways: GreenhouseWalkway[];
}

export interface GreenhouseMapDetail {
  id: number;
  siteId: number;
  siteName: string;
  name: string;
  northExtentFt: number;
  southExtentFt: number;
  eastExtentFt: number;
  westExtentFt: number;
  createdAt: string;
  updatedAt: string;
  compartments: GreenhouseCompartmentDetail[];
}

export interface AddBlockInput {
  orientation: RowOrientation;
  anchorSide: CompassSide;
  placementMode?: PlacementMode;
  offsetFt?: number;
  startRow: number;
  endRow: number;
  filter?: FilterMode;
  rowWidthFt: number;
  rowLengthFt: number;
  rowSpacingFt?: number;
  alongWallStart?: AlongWallStart;
  alongWallOffsetFt?: number;
}

export interface AddBlockResult extends GreenhouseRowBlock {
  created: number;
  skipped: number;
  total: number;
}

export interface MissingRowSlot {
  xFt: number;
  yFt: number;
  widthFt: number;
  lengthFt: number;
  orientation: RowOrientation;
  inferredRowNumber: number | null;
  neighborRowNumbers: [number, number];
}

export interface InsertRowInput {
  rowNumber: number;
  xFt: number;
  yFt: number;
  widthFt: number;
  lengthFt: number;
  orientation: RowOrientation;
}

export interface AddWalkwayInput {
  orientation: RowOrientation;
  widthFt: number;
  offsetFromSide?: WalkwayOffsetSide;
  offsetFt?: number;
  label?: string;
}

export interface BothSidesLayoutInput {
  orientation: RowOrientation;
  walkwayWidthFt?: number;
  rowWidthFt: number;
  rowLengthFt: number;
  rowSpacingFt?: number;
  sideA: { anchorSide: CompassSide; startRow: number; endRow: number; filter?: FilterMode };
  sideB: { anchorSide: CompassSide; startRow: number; endRow: number; filter?: FilterMode };
}

// ── API client ─────────────────────────────────────────────────────────────────

export const greenhouseApi = {
  listMaps: (siteId?: number) => {
    const q = siteId != null ? `?siteId=${siteId}` : '';
    return apiFetch<GreenhouseMapListItem[]>(`/api/greenhouse-maps${q}`);
  },

  getMap: (id: number) =>
    apiFetch<GreenhouseMapDetail>(`/api/greenhouse-maps/${id}`).then(map => ({
      ...map,
      compartments: map.compartments.map(c => ({
        ...c,
        blocks: (c.blocks ?? []).map(b => ({
          ...b,
          alongWallStart: b.alongWallStart ?? 'near',
          alongWallOffsetFt: b.alongWallOffsetFt ?? 0,
        })),
        walkways: c.walkways ?? [],
        rows: (c.blocks ?? []).flatMap(b => b.rows),
      })),
    })),

  createMap: (data: { siteId: number; name: string }) =>
    apiFetch<{ id: number; siteId: number; name: string }>('/api/greenhouse-maps', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateMap: (id: number, data: Partial<{ name: string; northExtentFt: number; southExtentFt: number; eastExtentFt: number; westExtentFt: number }>) =>
    apiFetch<{ id: number; name: string; northExtentFt: number; southExtentFt: number; eastExtentFt: number; westExtentFt: number }>(`/api/greenhouse-maps/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteMap: (id: number) =>
    apiFetch<void>(`/api/greenhouse-maps/${id}`, { method: 'DELETE' }),

  addCompartment: (mapId: number, data: { name: string; eastWestFt: number; northSouthFt: number }) =>
    apiFetch<GreenhouseCompartmentDetail>(`/api/greenhouse-maps/${mapId}/compartments`, {
      method: 'POST',
      body: JSON.stringify(data),
    }).then(c => ({ ...c, rows: [] })),

  updateCompartment: (
    mapId: number,
    id: number,
    data: Partial<{ name: string; eastWestFt: number; northSouthFt: number; xFt: number; yFt: number }>
  ) =>
    apiFetch<GreenhouseCompartmentDetail>(
      `/api/greenhouse-maps/${mapId}/compartments/${id}`,
      { method: 'PATCH', body: JSON.stringify(data) }
    ),

  deleteCompartment: (mapId: number, id: number) =>
    apiFetch<void>(`/api/greenhouse-maps/${mapId}/compartments/${id}`, { method: 'DELETE' }),

  addBlock: (mapId: number, compartmentId: number, data: AddBlockInput) =>
    apiFetch<AddBlockResult>(
      `/api/greenhouse-maps/${mapId}/compartments/${compartmentId}/blocks`,
      { method: 'POST', body: JSON.stringify(data) }
    ),

  deleteBlock: (mapId: number, compartmentId: number, blockId: number) =>
    apiFetch<void>(
      `/api/greenhouse-maps/${mapId}/compartments/${compartmentId}/blocks/${blockId}`,
      { method: 'DELETE' }
    ),

  addWalkway: (mapId: number, compartmentId: number, data: AddWalkwayInput) =>
    apiFetch<GreenhouseWalkway>(
      `/api/greenhouse-maps/${mapId}/compartments/${compartmentId}/walkways`,
      { method: 'POST', body: JSON.stringify(data) }
    ),

  deleteWalkway: (mapId: number, compartmentId: number, walkwayId: number) =>
    apiFetch<void>(
      `/api/greenhouse-maps/${mapId}/compartments/${compartmentId}/walkways/${walkwayId}`,
      { method: 'DELETE' }
    ),

  bothSidesLayout: (mapId: number, compartmentId: number, data: BothSidesLayoutInput) =>
    apiFetch<{ walkwayId: number | null; blockA: GreenhouseRowBlock; blockB: GreenhouseRowBlock }>(
      `/api/greenhouse-maps/${mapId}/compartments/${compartmentId}/layout/both-sides`,
      { method: 'POST', body: JSON.stringify(data) }
    ),

  getMissingRows: (mapId: number, compartmentId: number, blockId: number) =>
    apiFetch<{ missing: MissingRowSlot[] }>(
      `/api/greenhouse-maps/${mapId}/compartments/${compartmentId}/blocks/${blockId}/missing-rows`,
    ),

  insertRow: (mapId: number, compartmentId: number, blockId: number, data: InsertRowInput) =>
    apiFetch<GreenhouseRowDetail>(
      `/api/greenhouse-maps/${mapId}/compartments/${compartmentId}/blocks/${blockId}/rows`,
      { method: 'POST', body: JSON.stringify(data) },
    ),

  deleteRow: (mapId: number, compartmentId: number, rowId: number) =>
    apiFetch<void>(
      `/api/greenhouse-maps/${mapId}/compartments/${compartmentId}/rows/${rowId}`,
      { method: 'DELETE' }
    ),

  bulkDeleteRows: (mapId: number, rowIds: number[]) =>
    apiFetch<{ deleted: number; archived: number; total: number; notFound: number }>(
      `/api/greenhouse-maps/${mapId}/rows`,
      { method: 'DELETE', body: JSON.stringify({ rowIds }) }
    ),
};
