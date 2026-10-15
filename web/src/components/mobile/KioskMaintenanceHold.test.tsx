// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kiosk = vi.hoisted(() => ({ device: false, open: vi.fn(async () => {}) }));

vi.mock("../../lib/kiosk", () => ({
  useKioskDevice: () => kiosk.device,
  openKioskMaintenance: kiosk.open,
}));

import { KIOSK_HOLD_MS, KioskMaintenanceHold } from "./KioskMaintenanceHold";

async function renderTitle() {
  const view = render(
    <KioskMaintenanceHold>
      <h1>LabourLink</h1>
    </KioskMaintenanceHold>
  );
  // Let getKioskStatus() resolve.
  await act(async () => {});
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  kiosk.open.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  kiosk.device = false;
});

describe("KioskMaintenanceHold", () => {
  it("renders the title untouched (no wrapper, no handlers) on a non-kiosk device", async () => {
    const { container } = await renderTitle();
    expect(container.innerHTML).toBe("<h1>LabourLink</h1>");
    fireEvent.pointerDown(screen.getByText("LabourLink"));
    act(() => vi.advanceTimersByTime(KIOSK_HOLD_MS * 2));
    expect(kiosk.open).not.toHaveBeenCalled();
  });

  it("opens maintenance after a full five-second hold on a kiosk device", async () => {
    kiosk.device = true;
    await renderTitle();
    fireEvent.pointerDown(screen.getByTestId("kiosk-maintenance-hold"));
    act(() => vi.advanceTimersByTime(KIOSK_HOLD_MS - 1));
    expect(kiosk.open).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(kiosk.open).toHaveBeenCalledTimes(1);
  });

  it("does nothing if released early", async () => {
    kiosk.device = true;
    await renderTitle();
    const hold = screen.getByTestId("kiosk-maintenance-hold");
    fireEvent.pointerDown(hold);
    act(() => vi.advanceTimersByTime(4000));
    fireEvent.pointerUp(hold);
    act(() => vi.advanceTimersByTime(KIOSK_HOLD_MS));
    expect(kiosk.open).not.toHaveBeenCalled();
  });
});
