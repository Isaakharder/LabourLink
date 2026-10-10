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
    mockApi.mockImplementation(async (path: string) => (path.startsWith("/api/mobile/tags/mappings") ? { mappings: getCachedTagMappings() } : { mappingId: "m" }));

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

describe("build 16: assignments by hardware ID, removals, and activity/action tags", () => {
  const HW = "04A1B2C3";
  const hwTag = (hardwareId = HW): ScannedTag => ({ ...tagWithUuid(UUID_A), labourlinkTagUuid: null, hardwareId });
  const cached = { targetType: "carrier" as const, targetId: "bin-3", label: "Cart 3", labourlinkTagUuid: null, ridderHardwareId: HW };
  const mappingsResponse = (mappings: unknown[]) => (path: string) => Promise.resolve(path.startsWith("/api/mobile/tags/mappings") ? { mappings } : { removed: true, mappingId: "m" });

  it("reads a build-15 queue entry (no op / ridderHardwareId) as an assign", () => {
    localStorage.setItem("labourlink_pending_tag_registrations", JSON.stringify([{ ...entry(), op: undefined }]));
    expect(listPendingTags()[0]).toMatchObject({ op: "assign", ridderHardwareId: null });
    expect(resolveScannedTag(tagWithUuid(UUID_A))?.targetId).toBe("row-6");
  });

  it("an as-is assignment by hardware ID goes to /register; Replace confirms both sides", async () => {
    mockApi.mockImplementationOnce(() =>
      Promise.reject(new ApiError(409, "confirm", undefined, "TAG_ASSIGNED_ELSEWHERE", { code: "TAG_ASSIGNED_ELSEWHERE", tagConflict: { label: "Row 2" } }))
    );
    mockApi.mockImplementation(mappingsResponse([]));
    addPendingTag(entry({ id: "hw1", labourlinkTagUuid: null, ridderHardwareId: "04a1b2c3", targetType: "action", targetId: "start_break", label: "Start Break" }));
    await flushPendingTagRegistrations();
    expect(mockApi.mock.calls[0][0]).toBe("/api/mobile/tags/register");
    expect(JSON.parse(mockApi.mock.calls[0][1].body)).toEqual({ targetType: "action", targetId: "start_break", ridderHardwareId: HW });
    expect(listPendingTags()[0].status).toBe("conflict");
    await resolvePendingTagConflict("hw1", "replace");
    const replay = mockApi.mock.calls.filter(([p]) => p === "/api/mobile/tags/register")[1];
    expect(JSON.parse(replay[1].body)).toMatchObject({ confirmReplaceTarget: true, confirmReplaceTag: true });
    expect(listPendingTags()).toEqual([]);
  });

  it("an offline removal hides the cached assignment at once, survives a refresh, then syncs", async () => {
    localStorage.setItem("labourlink_nfc_tag_mappings_cache", JSON.stringify([cached]));
    setOnline(false);
    addPendingTag(entry({ id: "u1", op: "unassign", targetType: "carrier", targetId: "bin-3", label: "Cart 3", labourlinkTagUuid: null, ridderHardwareId: HW }));
    expect(resolveScannedTag(hwTag())).toBeNull();

    // A refresh that still lists it (server hasn't heard yet) must not resurrect it.
    setOnline(true);
    mockApi.mockImplementation((path: string) =>
      path === "/api/mobile/tags/unassign" ? Promise.reject(new ApiError(503, "down")) : mappingsResponse([cached])(path)
    );
    const { refreshTagMappingCache } = await import("./nfcMappingCache");
    await refreshTagMappingCache();
    expect(resolveScannedTag(hwTag())).toBeNull();
    await flushPendingTagRegistrations();
    expect(listPendingTags()[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(resolveScannedTag(hwTag())).toBeNull();

    mockApi.mockImplementation(mappingsResponse([]));
    await flushPendingTagRegistrations();
    const unassigns = mockApi.mock.calls.filter(([p]) => p === "/api/mobile/tags/unassign");
    const sent = unassigns[unassigns.length - 1];
    expect(JSON.parse(sent[1].body)).toEqual({ ridderHardwareId: HW, expectedTargetType: "carrier", expectedTargetId: "bin-3" });
    expect(listPendingTags()).toEqual([]);
    expect(getCachedTagMappings()).toEqual([]);
    expect(resolveScannedTag(hwTag())).toBeNull();
  });

  it("a removal refused because the tag was reassigned meanwhile is marked failed, and the server's assignment shows again", async () => {
    mockApi.mockImplementation((path: string) =>
      path === "/api/mobile/tags/unassign"
        ? Promise.reject(new ApiError(409, "now Cart 9", undefined, "ASSIGNMENT_CHANGED", { code: "ASSIGNMENT_CHANGED", error: "This tag is now assigned to Cart 9, so it was not removed." }))
        : mappingsResponse([{ ...cached, targetId: "bin-9", label: "Cart 9" }])(path)
    );
    addPendingTag(entry({ op: "unassign", targetType: "carrier", targetId: "bin-3", label: "Cart 3", labourlinkTagUuid: null, ridderHardwareId: HW }));
    await flushPendingTagRegistrations();
    expect(listPendingTags()[0]).toMatchObject({ status: "failed", lastError: "This tag is now assigned to Cart 9, so it was not removed." });
    expect(resolveScannedTag(hwTag())?.targetId).toBe("bin-9");
  });

  it("the latest operation for a tag wins, and both are sent in order", async () => {
    setOnline(false);
    addPendingTag(entry({ id: "a", writtenAt: "2026-10-10T08:00:00Z", labourlinkTagUuid: null, ridderHardwareId: HW, targetType: "activity", targetId: "act-1", label: "Picking" }));
    addPendingTag(entry({ id: "b", writtenAt: "2026-10-10T08:01:00Z", op: "unassign", labourlinkTagUuid: null, ridderHardwareId: HW, targetType: "activity", targetId: "act-1", label: "Picking" }));
    expect(resolveScannedTag(hwTag())).toBeNull();
    addPendingTag(entry({ id: "c", writtenAt: "2026-10-10T08:02:00Z", labourlinkTagUuid: null, ridderHardwareId: HW, targetType: "action", targetId: "end_work", label: "End Work" }));
    expect(resolveScannedTag(hwTag())).toEqual({ targetType: "action", targetId: "end_work", label: "End Work" });

    setOnline(true);
    mockApi.mockImplementation(mappingsResponse([]));
    await flushPendingTagRegistrations();
    expect(mockApi.mock.calls.map(([p]) => p).filter((p) => !p.startsWith("/api/mobile/tags/mappings"))).toEqual([
      "/api/mobile/tags/register",
      "/api/mobile/tags/unassign",
      "/api/mobile/tags/register",
    ]);
  });

  it("several tags may share an activity or action; rows and bins keep one tag each", async () => {
    mockApi.mockImplementation(mappingsResponse([]));
    const { addToTagMappingCache } = await import("./nfcMappingCache");
    addToTagMappingCache({ targetType: "action", targetId: "start_break", label: "Start Break", labourlinkTagUuid: null, ridderHardwareId: "04000001" });
    addToTagMappingCache({ targetType: "action", targetId: "start_break", label: "Start Break", labourlinkTagUuid: null, ridderHardwareId: "04000002" });
    addToTagMappingCache({ ...cached, ridderHardwareId: "04000003" });
    addToTagMappingCache({ ...cached, ridderHardwareId: "04000004" });
    expect(getCachedTagMappings().map((m) => m.ridderHardwareId)).toEqual(["04000001", "04000002", "04000004"]);
  });
});
