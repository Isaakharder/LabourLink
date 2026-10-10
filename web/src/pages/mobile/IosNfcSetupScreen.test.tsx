// @vitest-environment jsdom
//
// iPhone Set Up NFC Tag: activities/rows/bins/actions assigned "as it is"
// (incl. read-only tags) or written and verified; Clear Tag's separate
// unassign/erase results; Custom Text / URL; offline queueing; conflicts never
// resolved silently. Native NFC and the network are mocked — this is NOT
// hardware verification.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannedTag } from "../../lib/nfc";

type Session = { onTag: (tag: ScannedTag) => void | Promise<void>; onError?: (m: string) => void; options?: { keepOpen?: boolean }; stop: ReturnType<typeof vi.fn> };
const h = vi.hoisted(() => ({
  online: false,
  role: "Administrator",
  sessions: [] as Session[],
  writeTag: vi.fn(),
  writeNdefRecords: vi.fn(),
  eraseTag: vi.fn(),
  api: vi.fn(),
}));

vi.mock("../../lib/platform", () => ({ isNativePlatform: () => true, isIosNativePlatform: () => true }));
vi.mock("../../context/WorkSessionContext", () => ({ useWorkSession: () => ({ me: { employee: { securityRole: h.role } }, online: h.online }) }));

const LANDS = [
  {
    id: "land-1",
    name: "GH",
    phases: [
      { id: "ph-2", name: "Phase 2", rows: [11, 9, 10].map((n) => ({ id: `p2-r${n}`, rowNumber: n })) },
      { id: "ph-1", name: "Phase 1", rows: [2, 1].map((n) => ({ id: `p1-r${n}`, rowNumber: n })) },
    ],
  },
];
const ACT_PICK = "11111111-1111-4111-8111-111111111111";
vi.mock("../../lib/referenceDataCache", () => ({
  fetchRowsWithCache: () => Promise.resolve({ data: { lands: LANDS }, fromCache: !h.online, cachedAt: null }),
  fetchCarriersWithCache: () => Promise.resolve({ data: { carriers: [{ id: "bin-3", name: "Cart 3" }] }, fromCache: !h.online, cachedAt: null }),
  fetchTagActivityTargetsWithCache: () =>
    Promise.resolve({ data: { activities: [{ id: ACT_PICK, name: "Picking" }, { id: "act-prune", name: "Pruning" }] }, fromCache: !h.online, cachedAt: null }),
}));

vi.mock("../../lib/nfc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/nfc")>();
  return {
    ...actual,
    isNfcSupported: () => Promise.resolve(true),
    startScanSession: (onTag: Session["onTag"], onError?: Session["onError"], _label?: string, _msg?: string, options?: Session["options"]) => {
      const stop = vi.fn();
      h.sessions.push({ onTag, onError, options, stop });
      return stop;
    },
    writeTag: h.writeTag,
    writeNdefRecords: h.writeNdefRecords,
    eraseTag: h.eraseTag,
  };
});

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, api: h.api };
});

import { ApiError } from "../../lib/api";
import { getCachedTagMappings, resolveScannedTag } from "../../lib/nfcMappingCache";
import { listPendingTags } from "../../lib/pendingTagStore";
import { IosNfcSetupScreen } from "./IosNfcSetupScreen";

const CACHE_KEY = "labourlink_nfc_tag_mappings_cache";
function tag(over: Partial<ScannedTag> = {}): ScannedTag {
  return { hardwareId: "04A1B2C3", labourlinkTagUuid: null, hasNdefData: false, isWritable: true, maxSize: 137, rawId: null, techTypes: [], tagType: null, ndefRecords: [], ...over };
}
function setOnline(v: boolean) {
  h.online = v;
  Object.defineProperty(navigator, "onLine", { value: v, configurable: true });
}
function lastSession() {
  return h.sessions[h.sessions.length - 1];
}
function posts(path: string) {
  return h.api.mock.calls.filter(([p]) => p === path).map(([, init]) => JSON.parse((init as { body: string }).body));
}
function renderKind(kind: string) {
  return render(
    <MemoryRouter initialEntries={[`/mobile/settings/nfc-setup/${kind}`]}>
      <Routes>
        <Route path="/mobile/settings/nfc-setup/:kind" element={<IosNfcSetupScreen />} />
        <Route path="/mobile/settings" element={<p>Settings page</p>} />
      </Routes>
    </MemoryRouter>
  );
}
async function scan(user: ReturnType<typeof userEvent.setup>, t: ScannedTag) {
  await user.click(screen.getByRole("button", { name: "Scan tag" }));
  await act(async () => lastSession().onTag(t));
}

beforeEach(() => {
  localStorage.clear();
  setOnline(false);
  h.role = "Administrator";
  h.sessions = [];
  h.writeTag.mockReset().mockResolvedValue({ ok: true, verified: true });
  h.writeNdefRecords.mockReset().mockResolvedValue({ ok: true, verified: true });
  h.eraseTag.mockReset().mockResolvedValue({ ok: true, verified: true });
  h.api.mockReset().mockImplementation(async (path: string) =>
    path.startsWith("/api/mobile/tags/mappings") ? { mappings: getCachedTagMappings() } : path === "/api/mobile/tags/unassign" ? { removed: true } : { mappingId: "m-1" }
  );
});
afterEach(() => {
  cleanup();
  setOnline(true);
});

describe("access", () => {
  it("is refused to a non-admin employee", () => {
    h.role = "Employee";
    renderKind("rows");
    expect(screen.getByText("This screen requires an Administrator or Manager role.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scan tag" })).not.toBeInTheDocument();
  });
});

describe("Rows / Bins / Activities", () => {
  it("rows: direct numeric list (no phase step), a read-only tag registered as it is, offline, usable at once, then synced via /register", async () => {
    const user = userEvent.setup();
    const first = renderKind("rows");
    await user.click(await screen.findByRole("button", { name: "10" }));
    expect(screen.queryByRole("button", { name: /Phase/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByRole("heading", { name: "Set up a tag for Phase 2 · Row 10" })).toBeInTheDocument();

    const ro = tag({ isWritable: false, hardwareId: "04ab12" });
    await scan(user, ro);
    expect(lastSession().options).toEqual({ keepOpen: true });
    expect(h.writeTag).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Tag set up — awaiting sync" })).toBeInTheDocument();
    expect(listPendingTags()[0]).toMatchObject({ op: "assign", targetType: "greenhouse_row", targetId: "p2-r10", ridderHardwareId: "04AB12", labourlinkTagUuid: null });
    expect(resolveScannedTag(ro)?.targetId).toBe("p2-r10");

    first.unmount(); // restart
    expect(resolveScannedTag(ro)?.targetId).toBe("p2-r10");
    setOnline(true);
    renderKind("rows");
    await waitFor(() => expect(listPendingTags()).toEqual([]));
    expect(posts("/api/mobile/tags/register")).toEqual([{ targetType: "greenhouse_row", targetId: "p2-r10", ridderHardwareId: "04AB12" }]);
    expect(resolveScannedTag(ro)?.targetId).toBe("p2-r10");
  });

  it("write mode needs the explicit overwrite confirmation, then writes and verifies in the kept-open session", async () => {
    setOnline(true);
    const user = userEvent.setup();
    renderKind("bins");
    await user.click(await screen.findByRole("button", { name: /Cart 3/ }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await user.click(screen.getByRole("radio", { name: /Write a new LabourLink tag/ }));
    expect(screen.getByRole("button", { name: "Scan tag" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /anything already on this tag will be replaced/ }));
    await scan(user, tag());
    expect(h.writeTag).toHaveBeenCalledTimes(1);
    const writtenId = h.writeTag.mock.calls[0][0] as string;
    expect(await screen.findByRole("heading", { name: "Tag assigned" })).toBeInTheDocument();
    expect(posts("/api/mobile/tags/write-mapping")).toEqual([{ targetType: "carrier", targetId: "bin-3", labourlinkTagUuid: writtenId }]);
    expect(lastSession().stop).toHaveBeenCalled();
  });

  it("a write that fails verification saves nothing", async () => {
    h.writeTag.mockResolvedValue({ ok: false, reason: "not_verified", message: "The tag was written but reading it back did not match." });
    const user = userEvent.setup();
    renderKind("activities");
    await user.click(await screen.findByRole("button", { name: "Picking" }));
    await user.click(screen.getByRole("radio", { name: /Write a new LabourLink tag/ }));
    await user.click(screen.getByRole("checkbox", { name: /will be replaced/ }));
    await scan(user, tag());
    expect(await screen.findByRole("heading", { name: "Write failed" })).toBeInTheDocument();
    expect(screen.getByText("Nothing was saved. The tag was not assigned.")).toBeInTheDocument();
    expect(listPendingTags()).toEqual([]);
  });

  it("write mode refuses a read-only tag", async () => {
    const user = userEvent.setup();
    renderKind("activities");
    await user.click(await screen.findByRole("button", { name: "Picking" }));
    await user.click(screen.getByRole("radio", { name: /Write a new LabourLink tag/ }));
    await user.click(screen.getByRole("checkbox", { name: /will be replaced/ }));
    await scan(user, tag({ isWritable: false }));
    expect(await screen.findByText(/This tag is read-only/)).toBeInTheDocument();
    expect(h.writeTag).not.toHaveBeenCalled();
    expect(listPendingTags()).toEqual([]);
  });

  it("a tag assigned to something else is never replaced or overwritten", async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify([{ targetType: "greenhouse_row", targetId: "p1-r1", label: "Phase 1 · Row 1", labourlinkTagUuid: null, ridderHardwareId: "04A1B2C3" }]));
    const user = userEvent.setup();
    renderKind("activities");
    await user.click(await screen.findByRole("button", { name: "Picking" }));
    await user.click(screen.getByRole("radio", { name: /Write a new LabourLink tag/ }));
    await user.click(screen.getByRole("checkbox", { name: /will be replaced/ }));
    await scan(user, tag());
    expect(await screen.findByText(/assigned to Phase 1 · Row 1\. Use Clear Tag first/)).toBeInTheDocument();
    expect(h.writeTag).not.toHaveBeenCalled();
    expect(listPendingTags()).toEqual([]);
  });

  it("a server conflict waits for an explicit Replace", async () => {
    setOnline(true);
    h.api.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (path === "/api/mobile/tags/register" && !JSON.parse(init?.body ?? "{}").confirmReplaceTarget) {
        throw new ApiError(409, "This would change an existing mapping — confirm to proceed.", undefined, "TARGET_HAS_DIFFERENT_TAG", {
          code: "TARGET_HAS_DIFFERENT_TAG",
          targetConflict: { label: "Phase 2 · Row 10", ridderHardwareId: "04FFEE", labourlinkTagUuid: null },
        });
      }
      return path.startsWith("/api/mobile/tags/mappings") ? { mappings: [] } : { mappingId: "m-2" };
    });
    const user = userEvent.setup();
    renderKind("rows");
    await user.click(await screen.findByRole("button", { name: "10" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await scan(user, tag());
    expect(await screen.findByRole("heading", { name: "Tag set up — not registered yet" })).toBeInTheDocument();
    expect(posts("/api/mobile/tags/register")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Replace with this tag" }));
    expect(await screen.findByRole("heading", { name: "Tag assigned" })).toBeInTheDocument();
    expect(posts("/api/mobile/tags/register")[1]).toMatchObject({ confirmReplaceTarget: true, confirmReplaceTag: true });
    expect(listPendingTags()).toEqual([]);
  });
});

describe("Start Break / End Break / End Work", () => {
  it.each([
    ["start-break", "start_break", "Start Break"],
    ["end-break", "end_break", "End Break"],
    ["end-work", "end_work", "End Work"],
  ])("%s assigns the tag to its action without a target step", async (kind, action, label) => {
    const user = userEvent.setup();
    renderKind(kind);
    expect(screen.getByRole("heading", { name: `Set up a tag for ${label}` })).toBeInTheDocument();
    await scan(user, tag());
    expect(await screen.findByRole("heading", { name: "Tag set up — awaiting sync" })).toBeInTheDocument();
    expect(resolveScannedTag(tag())).toEqual({ targetType: "action", targetId: action, label });
  });

  it("a second tag for the same action is allowed (several break points)", async () => {
    setOnline(true);
    const user = userEvent.setup();
    renderKind("start-break");
    await scan(user, tag({ hardwareId: "04000001" }));
    await screen.findByRole("heading", { name: "Tag assigned" });
    await user.click(screen.getByRole("button", { name: "Set up another tag" }));
    await scan(user, tag({ hardwareId: "04000002" }));
    await screen.findByRole("heading", { name: "Tag assigned" });
    expect(resolveScannedTag(tag({ hardwareId: "04000001" }))?.targetId).toBe("start_break");
    expect(resolveScannedTag(tag({ hardwareId: "04000002" }))?.targetId).toBe("start_break");
  });
});

describe("Clear Tag", () => {
  const assigned = { targetType: "carrier", targetId: "bin-3", label: "Cart 3", labourlinkTagUuid: null, ridderHardwareId: "04A1B2C3" };

  it("offline: unassigns at once, keeps contents unless erase is chosen, and a cache refresh can't bring it back", async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify([assigned]));
    const user = userEvent.setup();
    renderKind("clear");
    await scan(user, tag());
    expect(await screen.findByText(/Removed its assignment to Cart 3 on this phone/)).toBeInTheDocument();
    expect(screen.getByText("The tag's contents were left unchanged.")).toBeInTheDocument();
    expect(h.eraseTag).not.toHaveBeenCalled();
    expect(resolveScannedTag(tag())).toBeNull();
    // The server still lists it until the removal syncs; it stays suppressed.
    expect(getCachedTagMappings()).toHaveLength(1);
    expect(resolveScannedTag(tag())).toBeNull();
    expect(listPendingTags()[0]).toMatchObject({ op: "unassign", targetType: "carrier", targetId: "bin-3", ridderHardwareId: "04A1B2C3" });

    cleanup();
    setOnline(true);
    renderKind("clear");
    await waitFor(() => expect(listPendingTags()).toEqual([]));
    expect(posts("/api/mobile/tags/unassign")).toEqual([{ ridderHardwareId: "04A1B2C3", expectedTargetType: "carrier", expectedTargetId: "bin-3" }]);
    expect(resolveScannedTag(tag())).toBeNull();
  });

  it("a read-only tag is unassigned but explains it can't be erased", async () => {
    setOnline(true);
    localStorage.setItem(CACHE_KEY, JSON.stringify([assigned]));
    const user = userEvent.setup();
    renderKind("clear");
    await user.click(screen.getByRole("checkbox", { name: /Also erase/ }));
    await scan(user, tag({ isWritable: false }));
    expect(await screen.findByText("Removed its assignment to Cart 3.")).toBeInTheDocument();
    expect(screen.getByText(/Not erased: this tag is read-only/)).toBeInTheDocument();
    expect(h.eraseTag).not.toHaveBeenCalled();
  });

  it("reports a failed erase separately from a successful unassign", async () => {
    setOnline(true);
    h.eraseTag.mockResolvedValue({ ok: false, reason: "write_failed", message: "The tag moved away." });
    localStorage.setItem(CACHE_KEY, JSON.stringify([assigned]));
    const user = userEvent.setup();
    renderKind("clear");
    await user.click(screen.getByRole("checkbox", { name: /Also erase/ }));
    await scan(user, tag());
    expect(await screen.findByText("Removed its assignment to Cart 3.")).toBeInTheDocument();
    expect(screen.getByText("Not erased: The tag moved away.")).toBeInTheDocument();
  });

  it("an unassigned tag can still be erased", async () => {
    const user = userEvent.setup();
    renderKind("clear");
    await user.click(screen.getByRole("checkbox", { name: /Also erase/ }));
    await scan(user, tag());
    expect(await screen.findByText("This tag had no LabourLink assignment.")).toBeInTheDocument();
    expect(screen.getByText("Erased the tag's contents.")).toBeInTheDocument();
    expect(listPendingTags()).toEqual([]);
  });

  it("a removal the server refuses because the tag was reassigned is reported, not forced", async () => {
    setOnline(true);
    localStorage.setItem(CACHE_KEY, JSON.stringify([assigned]));
    h.api.mockImplementation(async (path: string) => {
      if (path === "/api/mobile/tags/unassign") {
        throw new ApiError(409, "This tag is now assigned to Cart 9, so it was not removed.", undefined, "ASSIGNMENT_CHANGED", {
          code: "ASSIGNMENT_CHANGED",
          error: "This tag is now assigned to Cart 9, so it was not removed.",
        });
      }
      return { mappings: [{ ...assigned, targetId: "bin-9", label: "Cart 9" }] };
    });
    const user = userEvent.setup();
    renderKind("clear");
    await scan(user, tag());
    expect(await screen.findByText(/Assignment not removed: This tag is now assigned to Cart 9/)).toBeInTheDocument();
  });

  it("clearing a tag whose own assignment was refused as a conflict drops that local assignment", async () => {
    localStorage.setItem(
      "labourlink_pending_tag_registrations",
      JSON.stringify([
        {
          id: "c1", op: "assign", targetType: "carrier", targetId: "bin-3", label: "Cart 3", labourlinkTagUuid: null, ridderHardwareId: "04A1B2C3",
          writtenAt: "2026-10-01T00:00:00Z", status: "conflict", attempts: 1, lastError: "x", conflict: null, confirmReplaceTarget: false,
        },
      ])
    );
    expect(resolveScannedTag(tag())?.targetId).toBe("bin-3");
    const user = userEvent.setup();
    renderKind("clear");
    await scan(user, tag());
    await screen.findByText(/Removed its assignment to Cart 3/);
    expect(listPendingTags().map((e) => e.op)).toEqual(["unassign"]);
    expect(resolveScannedTag(tag())).toBeNull();
  });
});

describe("Custom Text / URL", () => {
  it("validates, requires overwrite confirmation, writes and verifies", async () => {
    const user = userEvent.setup();
    renderKind("custom");
    await user.click(screen.getByRole("radio", { name: "URL" }));
    await user.type(screen.getByRole("textbox", { name: "URL" }), "javascript:alert(1)");
    expect(screen.getByText(/Only http:\/\/ and https:\/\/ URLs/)).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "URL" }));
    await user.type(screen.getByRole("textbox", { name: "URL" }), "https://example.com/safety");
    expect(screen.getByRole("button", { name: "Scan tag" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /will be replaced/ }));
    await scan(user, tag());
    expect(await screen.findByRole("heading", { name: "URL written" })).toBeInTheDocument();
    expect(h.writeNdefRecords).toHaveBeenCalledTimes(1);
    expect(listPendingTags()).toEqual([]);
  });

  it("refuses LabourLink tag-ID content and never writes over an assigned tag", async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify([{ targetType: "action", targetId: "end_work", label: "End Work", labourlinkTagUuid: null, ridderHardwareId: "04A1B2C3" }]));
    const user = userEvent.setup();
    renderKind("custom");
    await user.type(screen.getByRole("textbox", { name: "Text" }), "labourlink://tag/v1/abc");
    expect(screen.getByText(/looks like a LabourLink tag ID/)).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Text" }));
    await user.type(screen.getByRole("textbox", { name: "Text" }), "Hello");
    await user.click(screen.getByRole("checkbox", { name: /will be replaced/ }));
    await scan(user, tag());
    expect(await screen.findByText(/assigned to End Work\. Clear it first/)).toBeInTheDocument();
    expect(h.writeNdefRecords).not.toHaveBeenCalled();
  });

  it("a cancelled scan returns to the form without writing", async () => {
    const user = userEvent.setup();
    renderKind("custom");
    await user.type(screen.getByRole("textbox", { name: "Text" }), "Hello");
    await user.click(screen.getByRole("checkbox", { name: /will be replaced/ }));
    await user.click(screen.getByRole("button", { name: "Scan tag" }));
    await act(async () => lastSession().onError?.("Scan cancelled."));
    expect(screen.getByText("Scan cancelled.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan tag" })).toBeEnabled();
    expect(h.writeNdefRecords).not.toHaveBeenCalled();
  });
});
