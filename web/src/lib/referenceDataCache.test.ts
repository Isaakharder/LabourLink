// @vitest-environment jsdom
// Stage 6 scenario coverage: reference-data cache behavior — "refresh when
// online, keep last valid cache on failure, never silently overwrite a
// good cache with a failed refresh's absence of data" (see
// referenceDataCache.ts's own header comment). Mocks localEventStore (the
// durable KV backing store) and api() at the module boundary — see the
// research this test was built from: no existing test lets the real
// SQLite/jeep-sqlite chain run under vitest, and this one doesn't either.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiError } from "./api";

// vi.mock factories are hoisted above every import/const in this file — a
// factory referencing a plain `const` declared below it hits the temporal
// dead zone at hoist time. vi.hoisted() runs (and returns) before that
// hoisting, so the mock fns it creates are safely available inside the
// factories below.
const { mockGetCachedJson, mockSetCachedJson, mockApi } = vi.hoisted(() => ({
  mockGetCachedJson: vi.fn(),
  mockSetCachedJson: vi.fn(),
  mockApi: vi.fn(),
}));

vi.mock("./localEventStore", () => ({
  getLocalEventStore: () => ({
    getCachedJson: mockGetCachedJson,
    setCachedJson: mockSetCachedJson,
  }),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, api: mockApi };
});

// Imported AFTER the mocks above are registered (vi.mock is hoisted by
// vitest regardless of import order, but this keeps the intent obvious).
import { fetchActivitiesWithCache, fetchRowsWithCache, fetchCarriersWithCache, resolveDisplayLabels } from "./referenceDataCache";

beforeEach(() => {
  mockGetCachedJson.mockReset();
  // fetchWithCache's cache write is fire-and-forget (.catch()'d, never
  // awaited) but still needs a real Promise to call .catch() on.
  mockSetCachedJson.mockReset().mockResolvedValue(undefined);
  mockApi.mockReset();
});

describe("fetchActivitiesWithCache (fetch-live-or-fallback-to-cache)", () => {
  it("returns live data and durably caches it on success", async () => {
    const liveData = { activities: [{ id: "a1", name: "Picking", normalSpeed: null, speedUnit: null, questions: [] }], activityGroups: [] };
    mockApi.mockResolvedValueOnce(liveData);

    const result = await fetchActivitiesWithCache();

    expect(result.data).toEqual(liveData);
    expect(result.fromCache).toBe(false);
    expect(result.cachedAt).toBeNull();
    // Fire-and-forget cache write — happens, but the live data returned
    // doesn't wait on it succeeding.
    expect(mockSetCachedJson).toHaveBeenCalledWith("activities", liveData);
  });

  it("falls back to the last cached value when the live fetch fails", async () => {
    mockApi.mockRejectedValueOnce(new ApiError(0, "Network error"));
    const cachedData = { activities: [{ id: "a1", name: "Stale Picking", normalSpeed: null, speedUnit: null, questions: [] }], activityGroups: [] };
    mockGetCachedJson.mockResolvedValueOnce({ value: cachedData, cachedAt: "2026-08-10T00:00:00.000Z" });

    const result = await fetchActivitiesWithCache();

    expect(result.data).toEqual(cachedData);
    expect(result.fromCache).toBe(true);
    expect(result.cachedAt).toBe("2026-08-10T00:00:00.000Z");
  });

  it("never overwrites a good cache with a failed refresh's absence of data — setCachedJson is only called on a successful live fetch", async () => {
    mockApi.mockRejectedValueOnce(new ApiError(0, "Network error"));
    mockGetCachedJson.mockResolvedValueOnce({ value: { activities: [], activityGroups: [] }, cachedAt: "2026-08-10T00:00:00.000Z" });

    await fetchActivitiesWithCache();

    expect(mockSetCachedJson).not.toHaveBeenCalled();
  });

  it("rethrows when the live fetch fails AND nothing was ever cached (a genuinely first-ever launch, offline)", async () => {
    const err = new ApiError(0, "Network error");
    mockApi.mockRejectedValueOnce(err);
    mockGetCachedJson.mockResolvedValueOnce(null);

    await expect(fetchActivitiesWithCache()).rejects.toBe(err);
  });
});

describe("fetchRowsWithCache / fetchCarriersWithCache use their own distinct cache keys", () => {
  it("caches rows under 'greenhouse-rows', not colliding with activities or carriers", async () => {
    const liveData = { lands: [] };
    mockApi.mockResolvedValueOnce(liveData);
    await fetchRowsWithCache();
    expect(mockSetCachedJson).toHaveBeenCalledWith("greenhouse-rows", liveData);
  });

  it("caches carriers under 'carriers'", async () => {
    const liveData = { carriers: [] };
    mockApi.mockResolvedValueOnce(liveData);
    await fetchCarriersWithCache();
    expect(mockSetCachedJson).toHaveBeenCalledWith("carriers", liveData);
  });
});

describe("resolveDisplayLabels (never triggers a network call — reads only what's already cached)", () => {
  it("resolves activity/row/carrier names from whatever is currently cached", async () => {
    mockGetCachedJson.mockImplementation(async (key: string) => {
      if (key === "activities") {
        return { value: { activities: [{ id: "a1", name: "Picking Peppers" }], activityGroups: [] }, cachedAt: "x" };
      }
      if (key === "greenhouse-rows") {
        return {
          value: { lands: [{ id: "l1", name: "Land 1", phases: [{ id: "p1", name: "Phase 1", rows: [{ id: "r1", rowNumber: 7 }] }] }] },
          cachedAt: "x",
        };
      }
      if (key === "carriers") {
        return { value: { carriers: [{ id: "c1", name: "Bin A" }] }, cachedAt: "x" };
      }
      return null;
    });

    const result = await resolveDisplayLabels("a1", "r1", "c1");

    expect(result.activityName).toBe("Picking Peppers");
    expect(result.rowLabel).toBe("Phase 1 · Row 7");
    expect(result.carrierName).toBe("Bin A");
    expect(mockApi).not.toHaveBeenCalled();
  });

  it("resolves to null fields (never throws) when an id isn't found in the cache", async () => {
    mockGetCachedJson.mockResolvedValue(null);

    const result = await resolveDisplayLabels("unknown-activity", "unknown-row", "unknown-carrier");

    expect(result.activityName).toBeNull();
    expect(result.rowLabel).toBeNull();
    expect(result.carrierName).toBeNull();
  });

  it("resolves to null fields when the ids themselves are null (nothing to look up)", async () => {
    mockGetCachedJson.mockResolvedValue(null);

    const result = await resolveDisplayLabels(null, null, null);

    expect(result.activityName).toBeNull();
    expect(result.rowLabel).toBeNull();
    expect(result.carrierName).toBeNull();
  });
});
