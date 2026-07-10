import { apiFetch } from '@/lib/apiClient';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Crop {
  id: number;
  name: string;
  plantingDate: string;   // YYYY-MM-DD
  pullingDate: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  varietyCount: number;
}

export interface Variety {
  id: number;
  name: string;
  color: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  cropId: number;
  cropName: string;
  cropPlantingDate: string;
  cropPullingDate: string | null;
  cropArchivedAt: string | null;
}

export type CropStatus = 'active' | 'upcoming' | 'ended' | 'archived';
export type VarietyStatus = 'active' | 'upcoming' | 'ended' | 'archived';

export function getCropStatus(crop: Pick<Crop, 'archivedAt' | 'plantingDate' | 'pullingDate'>): CropStatus {
  if (crop.archivedAt) return 'archived';
  const today = new Date().toISOString().slice(0, 10);
  if (crop.plantingDate > today) return 'upcoming';
  if (crop.pullingDate && crop.pullingDate < today) return 'ended';
  return 'active';
}

export function getVarietyStatus(v: Pick<Variety, 'archivedAt' | 'cropArchivedAt' | 'cropPlantingDate' | 'cropPullingDate'>): VarietyStatus {
  if (v.archivedAt) return 'archived';
  if (v.cropArchivedAt) return 'archived';
  const today = new Date().toISOString().slice(0, 10);
  if (v.cropPullingDate && v.cropPullingDate < today) return 'ended';
  if (v.cropPlantingDate > today) return 'upcoming';
  return 'active';
}

// ── Extended types ─────────────────────────────────────────────────────────────

export interface CropLocation {
  id: number;
  cropId: number;
  rowId: number;
  rowNumber: number;
  side: string;
  widthFt: number;
  lengthFt: number;
  areaM2: number;
  mapName: string;
  compartmentName: string;
  locationCode: string | null;
  locationName: string | null;
  netAreaM2: number | null;
  startDate: string | null;
  endDate: string | null;
  plantCount: number | null;
  notes: string | null;
}

export interface CropPlantDensity {
  id: number;
  cropId: number;
  name: string;
  plantCount: number;
  areaM2: number;
  densityPerM2: number | null;
  notes: string | null;
  rowIds: number[];
  createdAt: string;
  updatedAt: string;
}

// ── API client ─────────────────────────────────────────────────────────────────

export const cropsApi = {
  list: () => apiFetch<Crop[]>('/api/crops'),

  get: (id: number) => apiFetch<Crop>(`/api/crops/${id}`),

  create: (data: { name: string; plantingDate: string; pullingDate?: string | null }) =>
    apiFetch<Crop>('/api/crops', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: number, data: Partial<{ name: string; plantingDate: string; pullingDate: string | null; archivedAt: string | null }>) =>
    apiFetch<{ id: number }>(`/api/crops/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  archive: (id: number) => cropsApi.update(id, { archivedAt: new Date().toISOString() }),
  restore: (id: number) => cropsApi.update(id, { archivedAt: null }),

  // Locations
  listLocations: (cropId: number) =>
    apiFetch<CropLocation[]>(`/api/crops/${cropId}/locations`),

  setLocations: (cropId: number, rowIds: number[]) =>
    apiFetch<{ linked: number }>(`/api/crops/${cropId}/locations`, {
      method: 'PUT',
      body: JSON.stringify({ rowIds }),
    }),

  // Plant density
  listPlantDensity: (cropId: number) =>
    apiFetch<CropPlantDensity[]>(`/api/crops/${cropId}/plant-density`),

  createPlantDensity: (cropId: number, data: {
    name?: string;
    plantCount: number;
    /** Required when rowIds is empty/absent. Computed server-side from rows when rowIds provided. */
    areaM2?: number;
    notes?: string | null;
    rowIds?: number[];
  }) =>
    apiFetch<{ id: number }>(`/api/crops/${cropId}/plant-density`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deletePlantDensity: (cropId: number, densityId: number) =>
    apiFetch<void>(`/api/crops/${cropId}/plant-density/${densityId}`, { method: 'DELETE' }),
};

export const varietiesApi = {
  list: (cropId?: number) => {
    const q = cropId != null ? `?cropId=${cropId}` : '';
    return apiFetch<Variety[]>(`/api/varieties${q}`);
  },

  create: (data: { cropId: number; name: string; color?: string | null }) =>
    apiFetch<{ id: number }>('/api/varieties', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: number, data: Partial<{ name: string; color: string | null; cropId: number; archivedAt: string | null }>) =>
    apiFetch<{ id: number }>(`/api/varieties/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  archive: (id: number) => varietiesApi.update(id, { archivedAt: new Date().toISOString() }),
  restore: (id: number) => varietiesApi.update(id, { archivedAt: null }),
};
