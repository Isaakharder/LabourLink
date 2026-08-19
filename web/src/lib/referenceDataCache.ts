// Offline-first reference-data caching: activities+questions, greenhouse
// rows/phases, and carriers — the lists ActivityPicker/RowPickerSheet/
// CarrierPickerSheet need to render at all. Every fetch here follows the
// same rule: try the live endpoint; on success, cache the response AND
// return it (unchanged from today's direct api() call); on failure, fall
// back to whatever was last cached rather than leaving the picker showing
// nothing. Never overwrites a good cache with a failed refresh's absence of
// data — see fetchWithCache's catch branch.
//
// NFC tag mappings already have their own working offline-first cache
// (lib/nfcMappingCache.ts, localStorage-backed) predating this file — left
// as-is rather than migrated here, since it already satisfies the same
// "cache the last good response, resolve scans against it offline" contract
// this file provides for everything else. Break-profile/rounding settings
// are applied server-side only (never rendered as a client picker), so
// there's nothing for a client-side cache to serve there.
import { api } from "./api";
import { getLocalEventStore } from "./localEventStore";
import { PickerActivity } from "../components/mobile/ActivityPicker";
import { RowPickerLand } from "../components/mobile/RowPickerSheet";
import { PickerCarrier } from "../components/mobile/CarrierPickerSheet";

const CACHE_KEYS = {
  activities: "activities",
  rows: "greenhouse-rows",
  carriers: "carriers",
} as const;

export interface ActivitiesResponse {
  activities: PickerActivity[];
  activityGroups: { id: string; name: string }[];
}
export interface RowsResponse {
  lands: RowPickerLand[];
}
export interface CarriersResponse {
  carriers: PickerCarrier[];
}

// cachedAt is null when the very first live fetch on a brand-new device
// (never cached before) succeeds — there's no "staleness" to report yet,
// since what's on screen IS the live response. Set only when data actually
// came from the cache fallback, so callers (e.g. a future "showing cached
// data from 2h ago" banner) can distinguish "live" from "offline fallback."
export interface CacheResult<T> {
  data: T;
  fromCache: boolean;
  cachedAt: string | null;
}

async function fetchWithCache<T>(cacheKey: string, path: string): Promise<CacheResult<T>> {
  try {
    const data = await api<T>(path);
    // Fire-and-forget the durable write — a slow/failed cache write must
    // never block or fail the picker actually showing fresh data it just
    // received live.
    void getLocalEventStore()
      .setCachedJson(cacheKey, data)
      .catch((err) => console.error(`[reference-cache] failed to cache ${cacheKey}:`, err));
    return { data, fromCache: false, cachedAt: null };
  } catch (err) {
    const cached = await getLocalEventStore().getCachedJson<T>(cacheKey);
    if (cached) {
      return { data: cached.value, fromCache: true, cachedAt: cached.cachedAt };
    }
    // Never cached before AND the live fetch just failed (e.g. a brand-new
    // device's very first launch happening offline) — genuinely nothing to
    // show, so the caller's existing error handling (handleApiError) is
    // what should run. Re-throwing preserves that exactly.
    throw err;
  }
}

export function fetchActivitiesWithCache(): Promise<CacheResult<ActivitiesResponse>> {
  return fetchWithCache<ActivitiesResponse>(CACHE_KEYS.activities, "/api/mobile/activities");
}
export function fetchRowsWithCache(): Promise<CacheResult<RowsResponse>> {
  return fetchWithCache<RowsResponse>(CACHE_KEYS.rows, "/api/mobile/greenhouse-rows");
}
export function fetchCarriersWithCache(): Promise<CacheResult<CarriersResponse>> {
  return fetchWithCache<CarriersResponse>(CACHE_KEYS.carriers, "/api/mobile/carriers");
}

export interface ResolvedDisplayLabels {
  activityName: string | null;
  minimumDurationMinutes: number | null;
  rowLabel: string | null;
  carrierName: string | null;
}

// Reads straight from whatever's already durably cached (never triggers a
// network call itself) — used by WorkSessionContext to build a readable
// local optimistic UI update without needing HomeScreen's own live picker
// state, which it has no access to (WorkSessionProvider is mounted above
// HomeScreen). Missing/never-cached data resolves to null fields rather
// than throwing — the caller (localSessionState.ts's applyLocalEventToMe)
// already treats a missing label as "blank until the next real sync fills
// it in," never a hard failure.
export async function resolveDisplayLabels(
  activityId: string | null,
  greenhouseRowId: string | null,
  carrierId: string | null
): Promise<ResolvedDisplayLabels> {
  const store = getLocalEventStore();
  const [activitiesCached, rowsCached, carriersCached] = await Promise.all([
    store.getCachedJson<ActivitiesResponse>(CACHE_KEYS.activities),
    store.getCachedJson<RowsResponse>(CACHE_KEYS.rows),
    store.getCachedJson<CarriersResponse>(CACHE_KEYS.carriers),
  ]);

  const activity = activityId ? activitiesCached?.value.activities.find((a) => a.id === activityId) : undefined;

  let rowLabel: string | null = null;
  if (greenhouseRowId && rowsCached) {
    for (const land of rowsCached.value.lands) {
      for (const phase of land.phases) {
        const row = phase.rows.find((r) => r.id === greenhouseRowId);
        if (row) {
          rowLabel = `${phase.name} · Row ${row.rowNumber}`;
          break;
        }
      }
      if (rowLabel) break;
    }
  }

  const carrier = carrierId ? carriersCached?.value.carriers.find((c) => c.id === carrierId) : undefined;

  return {
    activityName: activity?.name ?? null,
    // Not part of the cached activities response (PickerActivity has no
    // minimumDurationMinutes field — that's a /api/mobile/me-only,
    // server-computed figure). Left null here deliberately: HomeScreen's
    // nfcSwitchWarning.ts pre-check already runs BEFORE perform() is ever
    // called, reading it off the last real server sync's me.currentActivity
    // — this local optimistic update doesn't need its own copy, and the
    // value becomes fresh again on the next reconciliation regardless.
    minimumDurationMinutes: null,
    rowLabel,
    carrierName: carrier?.name ?? null,
  };
}
