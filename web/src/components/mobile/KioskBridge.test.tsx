// @vitest-environment jsdom
//
// KioskBridge: on a kiosk phone an employee must visibly receive a message
// while LabourLink stays in the foreground (foreground push handler +
// periodic refresh + alert). On every other device it must do nothing.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  kioskDevice: false,
  messages: [] as { recipientId: string }[],
  refresh: vi.fn(),
  alert: vi.fn(async () => {}),
  report: vi.fn(async () => {}),
  initPush: vi.fn(async () => ({ ok: true })),
  setHandler: vi.fn(),
}));

vi.mock("../../context/MessagesContext", () => ({
  useMessages: () => ({ pending: h.messages, refresh: h.refresh }),
}));
vi.mock("../../context/WorkSessionContext", () => ({
  useWorkSession: () => ({ pending: 0 }),
}));
vi.mock("../../lib/kiosk", () => ({
  useKioskDevice: () => h.kioskDevice,
  alertKioskMessage: h.alert,
  reportKioskStatus: h.report,
  onKioskNavigationBlocked: async () => () => {},
}));
vi.mock("../../lib/push", () => ({
  initAndroidPush: h.initPush,
  setForegroundPushHandler: h.setHandler,
}));

import { KIOSK_MESSAGE_POLL_MS, KioskBridge } from "./KioskBridge";

async function mount() {
  const view = render(<KioskBridge />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.messages = [];
  for (const f of [h.refresh, h.alert, h.report, h.initPush, h.setHandler]) f.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.kioskDevice = false;
});

describe("KioskBridge on a non-kiosk device", () => {
  it("does nothing at all", async () => {
    h.messages = [{ recipientId: "r1" }];
    const { container } = await mount();
    act(() => vi.advanceTimersByTime(KIOSK_MESSAGE_POLL_MS * 3));
    expect(container.innerHTML).toBe("");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.initPush).not.toHaveBeenCalled();
    expect(h.setHandler).not.toHaveBeenCalled();
  });
});

describe("KioskBridge on a kiosk phone", () => {
  beforeEach(() => {
    h.kioskDevice = true;
  });

  it("routes foreground pushes to a message refresh and requests push permission", async () => {
    await mount();
    expect(h.setHandler).toHaveBeenCalledWith(h.refresh);
    await act(async () => {});
    expect(h.initPush).toHaveBeenLastCalledWith(true, h.refresh);
  });

  it("re-checks outstanding messages every minute while foregrounded", async () => {
    await mount();
    act(() => vi.advanceTimersByTime(KIOSK_MESSAGE_POLL_MS * 2));
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it("alerts once per newly arrived message, not on every re-render", async () => {
    const view = await mount();
    expect(h.alert).not.toHaveBeenCalled();
    h.messages = [{ recipientId: "r1" }];
    view.rerender(<KioskBridge />);
    await act(async () => {});
    expect(h.alert).toHaveBeenCalledTimes(1);
    h.messages = [{ recipientId: "r1" }];
    view.rerender(<KioskBridge />);
    await act(async () => {});
    expect(h.alert).toHaveBeenCalledTimes(1);
    h.messages = [{ recipientId: "r1" }, { recipientId: "r2" }];
    view.rerender(<KioskBridge />);
    await act(async () => {});
    expect(h.alert).toHaveBeenCalledTimes(2);
  });

  it("clears the foreground handler on unmount", async () => {
    const view = await mount();
    view.unmount();
    expect(h.setHandler).toHaveBeenLastCalledWith(null);
  });
});
