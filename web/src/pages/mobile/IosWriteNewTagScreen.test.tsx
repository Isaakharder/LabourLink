// @vitest-environment jsdom
//
// iPhone Write New Tag, offline-capable: cached rows, one NFC session that
// writes + verifies, the assignment saved on this phone at once (scans
// immediately), queued registration sent after reconnecting, and conflicts
// that are never resolved silently. Native NFC and the network are mocked —
// this is NOT hardware verification.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannedTag } from "../../lib/nfc";

type Session = { onTag: (tag: ScannedTag) => void | Promise<void>; onError?: (m: string) => void; options?: { keepOpen?: boolean }; stop: ReturnType<typeof vi.fn> };
const h = vi.hoisted(() => ({
  online: false,
  sessions: [] as Session[],
  writeTag: vi.fn(),
  api: vi.fn(),
}));

vi.mock("../../lib/platform", () => ({ isNativePlatform: () => true, isIosNativePlatform: () => true }));
const me = { employee: { securityRole: "Administrator" } };
vi.mock("../../context/WorkSessionContext", () => ({ useWorkSession: () => ({ me, online: h.online }) }));

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
vi.mock("../../lib/referenceDataCache", () => ({
  fetchRowsWithCache: () => Promise.resolve({ data: { lands: LANDS }, fromCache: !h.online, cachedAt: null }),
  fetchCarriersWithCache: () => Promise.resolve({ data: { carriers: [{ id: "bin-3", name: "Cart 3" }] }, fromCache: !h.online, cachedAt: null }),
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
  };
});

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, api: h.api };
});

import { ApiError } from "../../lib/api";
import { getCachedTagMappings, resolveScannedTag } from "../../lib/nfcMappingCache";
import { listPendingTags } from "../../lib/pendingTagStore";
import { IosWriteNewTagScreen } from "./IosWriteNewTagScreen";

function blankTag(hardwareId = "04A1B2C3"): ScannedTag {
  return { hardwareId, labourlinkTagUuid: null, hasNdefData: false, isWritable: true, maxSize: 137, rawId: null, techTypes: [], tagType: null, ndefRecords: [] };
}
function tagWith(uuid: string): ScannedTag {
  return { ...blankTag(), labourlinkTagUuid: uuid, hasNdefData: true };
}
function setOnline(v: boolean) {
  h.online = v;
  Object.defineProperty(navigator, "onLine", { value: v, configurable: true });
}
function lastSession() {
  return h.sessions[h.sessions.length - 1];
}
function rowNumbers() {
  return Array.from(document.querySelectorAll(".mobile-row-grid .mobile-row-grid-item-number")).map((e) => e.textContent);
}
function renderScreen() {
  return render(
    <MemoryRouter>
      <IosWriteNewTagScreen />
    </MemoryRouter>
  );
}

let writtenId: string | null = null;
async function writeRow10(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Row" }));
  await screen.findByRole("button", { name: "10" });
  await user.click(screen.getByRole("button", { name: "10" }));
  await user.click(screen.getByRole("button", { name: "Confirm" }));
  expect(screen.getByRole("heading", { name: "Write a tag for Phase 2 · Row 10" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Scan and write tag" }));
  await act(async () => lastSession().onTag(blankTag()));
}

beforeEach(() => {
  localStorage.clear();
  setOnline(false);
  h.sessions = [];
  writtenId = null;
  h.writeTag.mockReset().mockImplementation(async (uuid: string) => {
    writtenId = uuid;
    return { ok: true, verified: true };
  });
  h.api.mockReset().mockImplementation(async (path: string) => (path === "/api/mobile/tags/mappings" ? { mappings: getCachedTagMappings() } : { mappingId: "m-1" }));
});
afterEach(() => {
  cleanup();
  setOnline(true);
});

describe("iPhone Write New Tag — offline", () => {
  it("writes offline from cached rows in one kept-open session, saves locally, scans immediately, survives a restart, and registers after reconnecting", async () => {
    const user = userEvent.setup();
    const first = renderScreen();
    expect(await screen.findByText(/Offline — tags you write are saved on this phone/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Row" }));
    await screen.findByRole("button", { name: "10" });
    expect(screen.queryByRole("button", { name: /Phase/ })).not.toBeInTheDocument();
    expect(rowNumbers()).toEqual(["1", "2", "9", "10", "11"]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await writeRow10(user);
    const session = lastSession();
    expect(session.options).toEqual({ keepOpen: true });
    expect(h.writeTag).toHaveBeenCalledTimes(1);
    expect(session.stop).toHaveBeenCalled(); // closed only after the write

    expect(await screen.findByRole("heading", { name: "Tag written — awaiting sync" })).toBeInTheDocument();
    expect(h.api.mock.calls.filter(([p]) => p === "/api/mobile/tags/write-mapping")).toHaveLength(0);
    const [queued] = listPendingTags();
    expect(queued).toMatchObject({ targetType: "greenhouse_row", targetId: "p2-r10", label: "Phase 2 · Row 10", status: "pending", labourlinkTagUuid: writtenId });

    // Immediate offline scanning on this phone.
    expect(resolveScannedTag(tagWith(writtenId!))).toEqual({ targetType: "greenhouse_row", targetId: "p2-r10", label: "Phase 2 · Row 10" });

    // App restart: everything comes back from storage.
    first.unmount();
    renderScreen();
    expect(await screen.findByText("Written — awaiting sync")).toBeInTheDocument();
    expect(resolveScannedTag(tagWith(writtenId!))?.targetId).toBe("p2-r10");

    // Reconnect: the queued registration is sent and the mapping moves to the cache.
    await act(async () => setOnline(true));
    cleanup();
    renderScreen();
    await waitFor(() => expect(listPendingTags()).toEqual([]));
    const post = h.api.mock.calls.find(([p]) => p === "/api/mobile/tags/write-mapping")!;
    expect(JSON.parse((post[1] as { body: string }).body)).toEqual({ targetType: "greenhouse_row", targetId: "p2-r10", labourlinkTagUuid: writtenId });
    expect(resolveScannedTag(tagWith(writtenId!))?.targetId).toBe("p2-r10");
  });

  it("a failed write saves nothing and says so", async () => {
    h.writeTag.mockResolvedValue({ ok: false, reason: "not_verified", message: "The tag was written but reading it back did not match." });
    const user = userEvent.setup();
    renderScreen();
    await writeRow10(user);
    expect(await screen.findByRole("heading", { name: "Write failed" })).toBeInTheDocument();
    expect(screen.getByText("Nothing was saved. The tag was not assigned.")).toBeInTheDocument();
    expect(listPendingTags()).toEqual([]);
    expect(lastSession().stop).toHaveBeenCalled();
  });

  it("a tag already assigned to another row is not written", async () => {
    localStorage.setItem(
      "labourlink_nfc_tag_mappings_cache",
      JSON.stringify([{ targetType: "greenhouse_row", targetId: "p1-r1", label: "Phase 1 · Row 1", labourlinkTagUuid: null, ridderHardwareId: "04A1B2C3" }])
    );
    const user = userEvent.setup();
    renderScreen();
    await writeRow10(user);
    expect(await screen.findByText(/already assigned to Phase 1 · Row 1\. It was not changed/)).toBeInTheDocument();
    expect(h.writeTag).not.toHaveBeenCalled();
    expect(listPendingTags()).toEqual([]);
  });

  it("a cancelled scan goes back to the ready step without writing", async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole("button", { name: "Row" }));
    await user.click(await screen.findByRole("button", { name: "10" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await user.click(screen.getByRole("button", { name: "Scan and write tag" }));
    await act(async () => lastSession().onError?.("Scan cancelled."));
    expect(screen.getByText("Scan cancelled.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan and write tag" })).toBeEnabled();
    expect(h.writeTag).not.toHaveBeenCalled();
  });
});

describe("iPhone Write New Tag — online", () => {
  it("registers immediately when online", async () => {
    setOnline(true);
    const user = userEvent.setup();
    renderScreen();
    await writeRow10(user);
    expect(await screen.findByRole("heading", { name: "Tag written and registered" })).toBeInTheDocument();
    expect(listPendingTags()).toEqual([]);
  });

  it("a registration conflict is never replaced silently; Replace and Keep are explicit", async () => {
    setOnline(true);
    h.api.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (path === "/api/mobile/tags/write-mapping" && !JSON.parse(init?.body ?? "{}").confirmReplaceTarget) {
        throw new ApiError(409, "This target already has a different active tag — confirm to proceed.", undefined, "TARGET_HAS_DIFFERENT_TAG", {
          code: "TARGET_HAS_DIFFERENT_TAG",
          targetConflict: { label: "Phase 2 · Row 10", ridderHardwareId: "04FFEE", labourlinkTagUuid: null },
        });
      }
      return path === "/api/mobile/tags/mappings" ? { mappings: [] } : { mappingId: "m-2" };
    });
    const user = userEvent.setup();
    renderScreen();
    await writeRow10(user);
    expect(await screen.findByRole("heading", { name: "Tag written — not registered yet" })).toBeInTheDocument();
    expect(screen.getByText(/already has a different tag \(Ridder 04FFEE\)/)).toBeInTheDocument();
    expect(listPendingTags()[0].status).toBe("conflict");
    // Only the one unconfirmed attempt so far.
    expect(h.api.mock.calls.filter(([p]) => p === "/api/mobile/tags/write-mapping")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Replace with new tag" }));
    expect(await screen.findByRole("heading", { name: "Tag written and registered" })).toBeInTheDocument();
    const replace = h.api.mock.calls.filter(([p]) => p === "/api/mobile/tags/write-mapping")[1];
    expect(JSON.parse((replace[1] as { body: string }).body)).toMatchObject({ labourlinkTagUuid: writtenId, confirmReplaceTarget: true });
    expect(listPendingTags()).toEqual([]);
  });
});
