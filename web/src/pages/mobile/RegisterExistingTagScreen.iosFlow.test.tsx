// @vitest-environment jsdom
//
// Register Existing Tag, row flow: on iOS Capacitor only, the row picker
// opens straight onto every row from every phase in numeric order (no phase
// step), and a successful registration returns to that same list at the same
// scroll position with every row registered this visit faintly highlighted,
// ready for the next row. Cancelled/failed/unconfirmed scans never mark a row.
// Android and the PWA keep the existing behavior (phase step first, back to a
// fresh picker, no highlights).
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannedTag } from "../../lib/nfc";

const platform = vi.hoisted(() => ({ ios: true }));
vi.mock("../../lib/platform", () => ({
  isNativePlatform: () => platform.ios,
  isIosNativePlatform: () => platform.ios,
}));

type Session = { onTag: (tag: ScannedTag) => void; onError?: (m: string) => void; stop: ReturnType<typeof vi.fn> };
const nfc = vi.hoisted(() => ({ sessions: [] as Session[] }));
vi.mock("../../lib/nfc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/nfc")>();
  return {
    ...actual,
    isNfcSupported: () => Promise.resolve(true),
    startScanSession: (onTag: Session["onTag"], onError?: Session["onError"]) => {
      const stop = vi.fn();
      nfc.sessions.push({ onTag, onError, stop });
      return stop;
    },
  };
});

vi.mock("../../lib/feedback", () => ({ playSuccessFeedback: vi.fn() }));
vi.mock("../../context/WorkSessionContext", () => ({
  useWorkSession: () => ({ me: { employee: { securityRole: "Administrator" } } }),
}));

const apiMock = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: (path: string, init?: RequestInit) => {
      if (path === "/api/mobile/greenhouse-rows") return Promise.resolve({ lands });
      if (path === "/api/mobile/carriers") return Promise.resolve({ carriers: [] });
      if (path === "/api/mobile/tags/register") return apiMock.register(JSON.parse(String(init?.body)));
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  };
});

import { ApiError } from "../../lib/api";
import { RegisterExistingTagScreen } from "./RegisterExistingTagScreen";

const lands = [
  {
    id: "land-1",
    name: "First Light",
    // Phase 2 listed first, with its rows out of order, so the iOS list has to
    // be sorted numerically across phases (1, 2, 3, 4, 9, 10, 11 — not by
    // phase, and not "1, 10, 11, 2").
    phases: [
      { id: "phase-2", name: "Phase 2", rows: [11, 9, 10].map((n) => ({ id: `row-${n}`, rowNumber: n })) },
      { id: "phase-1", name: "Phase 1", rows: [1, 2, 3, 4].map((n) => ({ id: `row-${n}`, rowNumber: n })) },
    ],
  },
];

function tag(hardwareId: string): ScannedTag {
  return {
    hardwareId,
    labourlinkTagUuid: null,
    hasNdefData: false,
    isWritable: null,
    maxSize: null,
    rawId: null,
    techTypes: [],
    tagType: null,
    ndefRecords: [],
  };
}

function lastSession(): Session {
  return nfc.sessions[nfc.sessions.length - 1];
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <RegisterExistingTagScreen />
    </MemoryRouter>
  );
}

function rowButton(n: number) {
  return screen.getByRole("button", { name: String(n) });
}

function gridRowNumbers(): string[] {
  return Array.from(document.querySelectorAll(".mobile-row-grid .mobile-row-grid-item-number")).map((el) => el.textContent ?? "");
}

// Opens Row (-> Phase 1 on Android/PWA only), scrolls both scroll
// containers, selects row `n`, confirms — leaving the screen in the "scan"
// step with a session open.
async function selectRowAndConfirm(user: ReturnType<typeof userEvent.setup>, n: number, scroll?: { sheet: number; grid: number }) {
  if (screen.queryByRole("button", { name: "Row" })) {
    await user.click(screen.getByRole("button", { name: "Row" }));
    if (platform.ios) {
      await screen.findByRole("button", { name: "1" });
    } else {
      await user.click(await screen.findByRole("button", { name: /Phase 1/ }));
    }
  }
  if (scroll) {
    document.querySelector<HTMLElement>(".mobile-sheet")!.scrollTop = scroll.sheet;
    document.querySelector<HTMLElement>(".mobile-row-grid")!.scrollTop = scroll.grid;
  }
  await user.click(rowButton(n));
  await user.click(screen.getByRole("button", { name: "Confirm" }));
  expect(await screen.findByText("Scan the existing tag")).toBeInTheDocument();
}

beforeEach(() => {
  platform.ios = true;
  nfc.sessions = [];
  apiMock.register.mockReset();
});
afterEach(() => cleanup());

describe("RegisterExistingTagScreen — iOS row flow", () => {
  it("opens straight onto every row from every phase, sorted numerically, with no phase step", async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole("button", { name: "Row" }));
    await screen.findByRole("button", { name: "1" });

    expect(screen.queryByRole("button", { name: /Phase/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Choose a row" })).toBeInTheDocument();
    expect(gridRowNumbers()).toEqual(["1", "2", "3", "4", "9", "10", "11"]);

    // Search still narrows the same list by row-number prefix.
    await user.type(screen.getByRole("searchbox"), "1");
    expect(gridRowNumbers()).toEqual(["1", "10", "11"]);
  });

  it("saves the row's own ID, including a row from a phase listed later", async () => {
    const user = userEvent.setup();
    apiMock.register.mockResolvedValue({ ok: true });
    renderScreen();
    await selectRowAndConfirm(user, 10);
    await act(async () => lastSession().onTag(tag("04CC")));
    expect(apiMock.register).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "greenhouse_row", targetId: "row-10", ridderHardwareId: "04CC" })
    );
    expect(await screen.findByText("✓ Row 10 registered")).toBeInTheDocument();
  });

  it("success: stops the scan session, confirms, returns to the same row list at the same scroll, highlights the row, and allows the next row", async () => {
    const user = userEvent.setup();
    apiMock.register.mockResolvedValue({ ok: true });
    renderScreen();

    await selectRowAndConfirm(user, 2, { sheet: 40, grid: 120 });
    const first = lastSession();
    await act(async () => first.onTag(tag("04AA")));

    // Native "Ready to Scan" session is torn down as soon as the tag is read.
    expect(first.stop).toHaveBeenCalled();
    expect(apiMock.register).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "greenhouse_row", targetId: "row-2", ridderHardwareId: "04AA" })
    );

    // Existing checkmark confirmation, unchanged.
    expect(await screen.findByText("✓ Row 2 registered")).toBeInTheDocument();
    // Same flat row list (every phase), never a phase list.
    expect(rowButton(1)).toBeInTheDocument();
    expect(rowButton(9)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Phase/ })).not.toBeInTheDocument();
    expect(document.querySelector<HTMLElement>(".mobile-sheet")!.scrollTop).toBe(40);
    expect(document.querySelector<HTMLElement>(".mobile-row-grid")!.scrollTop).toBe(120);
    // Only the confirmed row is highlighted; nothing pre-selected.
    expect(rowButton(2)).toHaveAttribute("data-registered", "true");
    expect(rowButton(2)).toHaveClass("mobile-row-grid-item-registered");
    expect(rowButton(1)).not.toHaveAttribute("data-registered");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();

    // Next row immediately.
    await selectRowAndConfirm(user, 3);
    expect(nfc.sessions).toHaveLength(2);
    await act(async () => lastSession().onTag(tag("04BB")));
    expect(await screen.findByText("✓ Row 3 registered")).toBeInTheDocument();
    expect(rowButton(2)).toHaveAttribute("data-registered", "true");
    expect(rowButton(3)).toHaveAttribute("data-registered", "true");
  });

  it("server failure: row stays unmarked, Try again reopens a scan, and 'Choose a different row' returns to the preserved list", async () => {
    const user = userEvent.setup();
    apiMock.register.mockRejectedValueOnce(new ApiError(500, "Server exploded"));
    renderScreen();

    await selectRowAndConfirm(user, 2, { sheet: 10, grid: 60 });
    await act(async () => lastSession().onTag(tag("04AA")));
    expect(await screen.findByText("Server exploded")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(nfc.sessions).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Choose a different row" }));
    expect(rowButton(2)).not.toHaveAttribute("data-registered");
    expect(document.querySelector<HTMLElement>(".mobile-row-grid")!.scrollTop).toBe(60);

    // Retry the same row, now succeeding.
    apiMock.register.mockResolvedValue({ ok: true });
    await selectRowAndConfirm(user, 2);
    await act(async () => lastSession().onTag(tag("04AA")));
    expect(await screen.findByText("✓ Row 2 registered")).toBeInTheDocument();
    expect(rowButton(2)).toHaveAttribute("data-registered", "true");
  });

  it("native sheet cancelled: no API call, row unmarked, can go back to the rows", async () => {
    const user = userEvent.setup();
    renderScreen();

    await selectRowAndConfirm(user, 4);
    await act(async () => lastSession().onError?.("Scan cancelled."));
    expect(screen.getByText("Scan cancelled.")).toBeInTheDocument();
    expect(apiMock.register).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Choose a different row" }));
    expect(rowButton(4)).not.toHaveAttribute("data-registered");
  });

  it("duplicate-tag conflict: cancelling keeps the row unmarked and returns to the rows; confirming marks it", async () => {
    const user = userEvent.setup();
    const conflictBody = { tagConflict: { label: "Row 9", ridderHardwareId: "04AA" }, targetConflict: null };
    apiMock.register.mockRejectedValueOnce(new ApiError(409, "conflict", undefined, undefined, conflictBody));
    renderScreen();

    await selectRowAndConfirm(user, 1);
    await act(async () => lastSession().onTag(tag("04AA")));
    expect(await screen.findByText(/already registered to/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(rowButton(1)).not.toHaveAttribute("data-registered");

    apiMock.register.mockRejectedValueOnce(new ApiError(409, "conflict", undefined, undefined, conflictBody));
    await selectRowAndConfirm(user, 1);
    await act(async () => lastSession().onTag(tag("04AA")));
    apiMock.register.mockResolvedValueOnce({ ok: true });
    await user.click(await screen.findByRole("button", { name: "Confirm and replace" }));
    expect(apiMock.register).toHaveBeenLastCalledWith(expect.objectContaining({ confirmReplaceTag: true }));
    expect(await screen.findByText("✓ Row 1 registered")).toBeInTheDocument();
    expect(rowButton(1)).toHaveAttribute("data-registered", "true");
  });

  it("highlights are cleared when the admin leaves and starts a new registration visit", async () => {
    const user = userEvent.setup();
    apiMock.register.mockResolvedValue({ ok: true });
    const first = renderScreen();
    await selectRowAndConfirm(user, 2);
    await act(async () => lastSession().onTag(tag("04AA")));
    await waitFor(() => expect(rowButton(2)).toHaveAttribute("data-registered", "true"));
    first.unmount();

    renderScreen();
    await user.click(screen.getByRole("button", { name: "Row" }));
    expect(await screen.findByRole("button", { name: "2" })).not.toHaveAttribute("data-registered");
  });
});

describe("RegisterExistingTagScreen — Android/PWA unchanged", () => {
  it("success returns to a freshly mounted picker (phase list), with no highlights or iOS-only actions", async () => {
    platform.ios = false;
    const user = userEvent.setup();
    apiMock.register.mockRejectedValueOnce(new ApiError(500, "nope")).mockResolvedValue({ ok: true });
    renderScreen();

    await selectRowAndConfirm(user, 2);
    await act(async () => lastSession().onTag(tag("04AA")));
    expect(await screen.findByText("nope")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose a different row" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => lastSession().onTag(tag("04AA")));
    expect(await screen.findByText("✓ Row 2 registered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Phase 1/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Phase 1/ }));
    expect(rowButton(2)).not.toHaveAttribute("data-registered");
  });
});
