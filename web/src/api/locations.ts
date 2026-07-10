import { apiFetch } from '@/lib/apiClient';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SiteDetail {
  id: number;
  code: string;
  name: string;
  address: string | null;
  timezone: string;
  companyName: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SiteListItem extends SiteDetail {
  locationCount: number;
  mapCount: number;
}

export interface LocationListItem {
  id: number;
  siteId: number;
  siteName: string;
  code: string;
  name: string;
  abbreviatedName: string | null;
  netAreaM2: string | null;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationDetail extends LocationListItem {
  siteCode: string;
  mapXM: string | null;
  mapYM: string | null;
  mapLengthM: string | null;
  mapWidthM: string | null;
}

export interface LocationScanCode {
  id: number;
  locationId: number;
  scanCode: string;
  scanType: 'qr' | 'rfid' | 'barcode' | 'manual';
  label: string | null;
  isPrimary: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationGroupListItem {
  id: number;
  siteId: number;
  siteName: string;
  code: string;
  name: string;
  netAreaM2: string | null;
  sortOrder: number;
  locationCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationGroupDetail {
  id: number;
  siteId: number;
  siteCode: string;
  siteName: string;
  code: string;
  name: string;
  netAreaM2: string | null;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationGroupMember {
  id: number;
  code: string;
  name: string;
  abbreviatedName: string | null;
  sortOrder: number;
  archivedAt: string | null;
}

// ── API client ────────────────────────────────────────────────────────────────

export const locationApi = {
  // ── Sites ──────────────────────────────────────────────────────────────────
  listSites: () =>
    apiFetch<SiteListItem[]>('/api/locations/sites'),

  site: (id: number) =>
    apiFetch<SiteDetail>(`/api/locations/sites/${id}`),

  createSite: (data: { name: string; code: string; address?: string; timezone?: string }) =>
    apiFetch<SiteListItem>('/api/locations/sites', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateSite: (
    id: number,
    data: Partial<Pick<SiteDetail, 'name' | 'code' | 'address' | 'timezone' | 'archivedAt'>>,
  ) =>
    apiFetch<{ ok: boolean }>(`/api/locations/sites/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteSite: (id: number) =>
    apiFetch<void>(`/api/locations/sites/${id}`, { method: 'DELETE' }),

  // ── Locations ──────────────────────────────────────────────────────────────
  list: (siteId?: number, includeArchived?: boolean) => {
    const params = new URLSearchParams();
    if (siteId) params.set('siteId', String(siteId));
    if (includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return apiFetch<LocationListItem[]>(`/api/locations${qs ? `?${qs}` : ''}`);
  },

  detail: (id: number) =>
    apiFetch<LocationDetail>(`/api/locations/${id}`),

  create: (data: {
    siteId: number;
    code: string;
    name: string;
    abbreviatedName?: string;
    netAreaM2?: number | null;
    mapXM?: number | null;
    mapYM?: number | null;
    mapLengthM?: number | null;
    mapWidthM?: number | null;
    sortOrder?: number;
  }) =>
    apiFetch<{ id: number }>('/api/locations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: number, data: Partial<{
    code: string;
    name: string;
    abbreviatedName: string | null;
    netAreaM2: number | null;
    mapXM: number | null;
    mapYM: number | null;
    mapLengthM: number | null;
    mapWidthM: number | null;
    sortOrder: number;
    archivedAt: string | null;
  }>) =>
    apiFetch<{ ok: boolean }>(`/api/locations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Which groups does this location belong to?
  locationGroups: (id: number) =>
    apiFetch<LocationGroupMember[]>(`/api/locations/${id}/groups`),

  // ── Scan Codes ─────────────────────────────────────────────────────────────
  scanCodes: (locationId: number) =>
    apiFetch<LocationScanCode[]>(`/api/locations/scan-codes?locationId=${locationId}`),

  createScanCode: (data: {
    locationId: number;
    scanCode: string;
    scanType: string;
    label?: string;
    isPrimary?: boolean;
  }) =>
    apiFetch<{ id: number }>('/api/locations/scan-codes', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateScanCode: (id: number, data: Partial<{
    scanCode: string;
    scanType: string;
    label: string | null;
    isPrimary: boolean;
    archivedAt: string | null;
  }>) =>
    apiFetch<{ ok: boolean }>(`/api/locations/scan-codes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // ── Location Groups ────────────────────────────────────────────────────────
  groupList: (siteId?: number, includeArchived?: boolean) => {
    const params = new URLSearchParams();
    if (siteId) params.set('siteId', String(siteId));
    if (includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return apiFetch<LocationGroupListItem[]>(`/api/location-groups${qs ? `?${qs}` : ''}`);
  },

  groupDetail: (id: number) =>
    apiFetch<LocationGroupDetail>(`/api/location-groups/${id}`),

  createGroup: (data: {
    siteId: number;
    code: string;
    name: string;
    netAreaM2?: number | null;
    sortOrder?: number;
  }) =>
    apiFetch<{ id: number }>('/api/location-groups', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateGroup: (id: number, data: Partial<{
    code: string;
    name: string;
    netAreaM2: number | null;
    sortOrder: number;
    archivedAt: string | null;
  }>) =>
    apiFetch<{ ok: boolean }>(`/api/location-groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  groupLocations: (groupId: number) =>
    apiFetch<LocationGroupMember[]>(`/api/location-groups/${groupId}/locations`),

  addToGroup: (groupId: number, locationId: number) =>
    apiFetch<{ ok: boolean }>(`/api/location-groups/${groupId}/locations`, {
      method: 'POST',
      body: JSON.stringify({ locationId }),
    }),

  removeFromGroup: (groupId: number, locationId: number) =>
    apiFetch<{ ok: boolean }>(`/api/location-groups/${groupId}/locations/${locationId}`, {
      method: 'DELETE',
    }),
};
