// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannedTag } from "./nfc";

const mockApi = vi.hoisted(() => vi.fn());
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, api: mockApi };
});

import { ApiError } from "./api";
import { getCachedTagMappings, resolveScannedTag } from "./nfcMappingCache";
import { addPendingTag, listPendingTags, PendingTagRegistration } from "./pendingTagStore";
import { classifyRegistrationError, flushPendingTagRegistrations, resolvePendingTagConflict } from "./pendingTagSync";

const UUID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const UUID_B = "bbbbbbbb-2222-4222-8222-222222222222";

function entry(overrides: Partial<PendingTagRegistration> = {}): PendingTagRegistration {
  return {
    id: overrides.id ?? `local-${Math.random()}`,
    targetType: "greenhouse_row",
    targetId: "row-6",
    label: "Phase 1 · Row 6",
    labourlinkTagUuid: UUID_A,
    writtenAt: "2026-10-09T23:40:00.000Z",
    status: "pending",
    attempts: 0,
    lastError: null,
    conflict: null,
    confirmReplaceTarget: false,
    ...overrides,
  };
}

function tagWithUuid(uuid: string): ScannedTag {
  return { hardwareId: "04AABBCC", labourlinkTagUuid: uuid, hasNdefData: true, isWritable: true, maxSize: 137, rawId: null, techTypes: [], tagType: null, ndefRecords: [] };
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  mockApi.mockReset();
  setOnline(true);
});
afterEach(() => setOnline(true));

describe("offline-written tags resolve on this phone immediately", () => {
  it("a pending tag resolves to its row before it is registered, with no network", () => {
    setOnline(false);
    addPendingTag(entry());
    expect(resolveScannedTag(tagWithUuid(UUID_A))).toEqual({ targetType: "greenhouse_row", targetId: "row-6", label: "Phase 1 · Row 6" });
  });

  it("a failed registration does not resolve (its tag ID may belong to something else)", () => {
    addPendingTag(entry({ status: "failed" }));
    expect(resolveScannedTag(tagWithUuid(UUID_A))).toBeNull();
  });
});

describe("flushPendingTagRegistrations", () => {
  it("does nothing offline", async () => {
    setOnline(false);
    addPendingTag(entry());
    await flushPendingTagRegistrations();
    expect(mockApi).not.toHaveBeenCalled();
    expect(listPendingTags()[0].status).toBe("pending");
  });

  it("registers oldest first without confirmReplaceTarget, then moves the mapping into the cache", async () => {
    addPendingTag(entry({ id: "later", labourlinkTagUuid: UUID_B, targetId: "row-7", label: "Phase 1 · Row 7", writtenAt: "2026-10-09T23:50:00.000Z" }));
    addPendingTag(entry({ id: "earlier" }));
    mockApi.mockImplementation(async (path: string) => (path === "/api/mobile/tags/mappings" ? { mappings: getCachedTagMappings() } : { mappingId: "m" }));

    await flushPendingTagRegistrations();

    const posts = mockApi.mock.calls.filter(([p]) => p === "/api/mobile/tags/write-mapping");
    expect(posts.map(([, init]) => JSON.parse((init as { body: string }).body).labourlinkTagUuid)).toEqual([UUID_A, UUID_B]);
    expect(posts.every(([, init]) => !("confirmReplaceTarget" in JSON.parse((init as { body: string }).body)))).toBe(true);
    expect(listPendingTags()).toEqual([]);
    expect(resolveScannedTag(tagWithUuid(UUID_A))?.targetId).toBe("row-6");
    expect(resolveScannedTag(tagWithUuid(UUID_B))?.targetId).toBe("row-7");
  });

  it("a target conflict is recorded, never replaced, and still resolves locally until an admin decides", async () => {
    addPendingTag(entry({ id: "t" }));
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/api/mobile/tags/write-mapping") {
        throw new ApiError(409, "This target already has a different active tag — confirm to proceed.", undefined, "TARGET_HAS_DIFFERENT_TAG", {
          code: "TARGET_HAS_DIFFERENT_TAG",
          targetConflict: { label: "Phase 1 · Row 6", ridderHardwareId: "04112233", labourlinkTagUuid: null },
        });
      }
      return { mappings: [] };
    });

    await flushPendingTagRegistrations();
    const [e] = listPendingTags();
    expect(e.status).toBe("conflict");
    expect(e.conflict?.ridderHardwareId).toBe("04112233");
    expect(resolveScannedTag(tagWithUuid(UUID_A))?.targetId).toBe("row-6");

    // A later flush doesn't retry a conflict by itself.
    mockApi.mockClear();
    await flushPendingTagRegistrations();
    expect(mockApi.mock.calls.filter(([p]) => p === "/api/mobile/tags/write-mapping")).toHaveLength(0);
  });

  it("'Replace' re-sends with confirmReplaceTarget; 'Keep existing' drops this phone's assignment", async () => {
    addPendingTag(entry({ id: "replace-me", status: "conflict" }));
    addPendingTag(entry({ id: "keep-them", status: "conflict", labourlinkTagUuid: UUID_B, targetId: "row-7" }));
    mockApi.mockResolvedValue({ mappingId: "m" });

    expect(await resolvePendingTagConflict("replace-me", "replace")).toBe("registered");
    const body = JSON.parse((mockApi.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({ labourlinkTagUuid: UUID_A, confirmReplaceTarget: true });

    expect(await resolvePendingTagConflict("keep-them", "keep")).toBe("removed");
    expect(listPendingTags()).toEqual([]);
    expect(resolveScannedTag(tagWithUuid(UUID_B))).toBeNull();
  });

  it("a tag ID already used elsewhere is marked failed with the server's message", async () => {
    addPendingTag(entry());
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/api/mobile/tags/write-mapping") {
        throw new ApiError(409, "This tag ID was just used by someone else.", undefined, "TAG_ID_IN_USE", { code: "TAG_ID_IN_USE", error: "This tag ID was just used by someone else." });
      }
      return { mappings: [] };
    });
    await flushPendingTagRegistrations();
    expect(listPendingTags()[0]).toMatchObject({ status: "failed", lastError: "This tag ID was just used by someone else." });
  });

  it("server unreachable: stays pending, attempt counted, later entries wait", async () => {
    addPendingTag(entry({ id: "first" }));
    addPendingTag(entry({ id: "second", labourlinkTagUuid: UUID_B, writtenAt: "2026-10-09T23:59:00.000Z" }));
    mockApi.mockRejectedValue(new TypeError("Load failed"));
    await flushPendingTagRegistrations();
    const posts = mockApi.mock.calls.filter(([p]) => p === "/api/mobile/tags/write-mapping");
    expect(posts).toHaveLength(1);
    expect(listPendingTags().map((e) => [e.id, e.status, e.attempts])).toEqual([
      ["first", "pending", 1],
      ["second", "pending", 0],
    ]);
  });
});

describe("classifyRegistrationError", () => {
  it("maps server answers to outcomes", () => {
    expect(classifyRegistrationError(new ApiError(500, "boom")).outcome).toBe("unreachable");
    expect(classifyRegistrationError(new TypeError("Load failed")).outcome).toBe("unreachable");
    expect(classifyRegistrationError(new ApiError(400, "targetId does not match an active row or carrier.")).outcome).toBe("failed");
    expect(classifyRegistrationError(new ApiError(403, "Admins only")).outcome).toBe("failed");
  });
});
