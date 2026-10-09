// @vitest-environment jsdom
//
// Write New Tag, row target: on iOS the row picker opens straight onto every
// row from every phase in numeric order (no phase step) and the mapping is
// saved against the chosen row's own ID. Android/PWA keep the phase step.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannedTag } from "../../lib/nfc";

const platform = vi.hoisted(() => ({ ios: true }));
vi.mock("../../lib/platform", () => ({
  isNativePlatform: () => platform.ios,
  isIosNativePlatform: () => platform.ios,
}));

const NEW_UUID = "11111111-2222-4333-8444-555555555555";
vi.mock("../../lib/uuid", () => ({ uuid: () => NEW_UUID }));

type Session = { onTag: (tag: ScannedTag) => void; stop: ReturnType<typeof vi.fn> };
const nfc = vi.hoisted(() => ({ sessions: [] as Session[] }));
vi.mock("../../lib/nfc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/nfc")>();
  return {
    ...actual,
    isNfcSupported: () => Promise.resolve(true),
    startScanSession: (onTag: Session["onTag"]) => {
      const stop = vi.fn();
      nfc.sessions.push({ onTag, stop });
      return stop;
    },
    writeTag: () => Promise.resolve({ ok: true }),
  };
});

vi.mock("../../context/WorkSessionContext", () => ({
  useWorkSession: () => ({ me: { employee: { securityRole: "Administrator" } } }),
}));

const apiMock = vi.hoisted(() => ({ writeMapping: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: (path: string, init?: RequestInit) => {
      if (path === "/api/mobile/greenhouse-rows") return Promise.resolve({ lands });
      if (path === "/api/mobile/carriers") return Promise.resolve({ carriers: [] });
      if (path === "/api/mobile/tags/write-mapping") return apiMock.writeMapping(JSON.parse(String(init?.body)));
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  };
});

import { WriteNewTagScreen } from "./WriteNewTagScreen";

const lands = [
  {
    id: "land-1",
    name: "First Light",
    phases: [
      { id: "phase-2", name: "Phase 2", rows: [11, 9, 10].map((n) => ({ id: `row-${n}`, rowNumber: n })) },
      { id: "phase-1", name: "Phase 1", rows: [2, 1].map((n) => ({ id: `row-${n}`, rowNumber: n })) },
    ],
  },
];

function tag(overrides: Partial<ScannedTag> = {}): ScannedTag {
  return {
    hardwareId: "04AA",
    labourlinkTagUuid: null,
    hasNdefData: false,
    isWritable: true,
    maxSize: 137,
    rawId: null,
    techTypes: [],
    tagType: null,
    ndefRecords: [],
    ...overrides,
  };
}

function lastSession(): Session {
  return nfc.sessions[nfc.sessions.length - 1];
}

function gridRowNumbers(): string[] {
  return Array.from(document.querySelectorAll(".mobile-row-grid .mobile-row-grid-item-number")).map((el) => el.textContent ?? "");
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <WriteNewTagScreen />
    </MemoryRouter>
  );
}

beforeEach(() => {
  platform.ios = true;
  nfc.sessions = [];
  apiMock.writeMapping.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

describe("WriteNewTagScreen — row picker", () => {
  it("iOS: no phase step, rows sorted numerically, and the mapping is saved to the chosen row's ID", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Row" }));
    await screen.findByRole("button", { name: "1" });
    expect(screen.queryByRole("button", { name: /Phase/ })).not.toBeInTheDocument();
    expect(gridRowNumbers()).toEqual(["1", "2", "9", "10", "11"]);

    await user.click(screen.getByRole("button", { name: "10" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await act(async () => lastSession().onTag(tag()));
    await user.click(await screen.findByRole("button", { name: "Write LabourLink tag" }));
    await act(async () => lastSession().onTag(tag({ labourlinkTagUuid: NEW_UUID, hasNdefData: true })));

    expect(apiMock.writeMapping).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "greenhouse_row", targetId: "row-10", labourlinkTagUuid: NEW_UUID })
    );
  });

  it("Android/PWA: still asks for the phase first", async () => {
    platform.ios = false;
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Row" }));
    expect(await screen.findByRole("button", { name: /Phase 1/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "10" })).not.toBeInTheDocument();
  });
});
