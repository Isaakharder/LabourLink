// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockSupported = true;
let mockIos = false;
const stopMock = vi.fn();
const startScanSessionMock = vi.fn(
  (onTag: (tag: unknown) => void, onError?: (message: string) => void) => {
    lastOnTag = onTag;
    lastOnError = onError;
    return stopMock;
  }
);
let lastOnTag: ((tag: unknown) => void) | null = null;
let lastOnError: ((message: string) => void) | undefined = undefined;

vi.mock("./nfc", () => ({
  isNfcSupported: () => Promise.resolve(mockSupported),
  startScanSession: (...args: Parameters<typeof startScanSessionMock>) => startScanSessionMock(...args),
}));

vi.mock("./platform", () => ({
  isIosNativePlatform: () => mockIos,
}));

import { useForegroundNfcScan } from "./useForegroundNfcScan";

beforeEach(() => {
  mockSupported = true;
  mockIos = false;
  stopMock.mockClear();
  startScanSessionMock.mockClear();
  lastOnTag = null;
  lastOnError = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useForegroundNfcScan — Android/web: ambient auto-start, unchanged", () => {
  it("auto-starts a session once supported+active, without any tap", async () => {
    mockIos = false;
    const onTag = vi.fn();
    const { result } = renderHook(() => useForegroundNfcScan({ active: true, onTag, label: "test" }));
    await flush();

    expect(startScanSessionMock).toHaveBeenCalledTimes(1);
    expect(result.current.scanning).toBe(true);
    expect(result.current.awaitingTap).toBe(false);
  });

  it("never sets awaitingTap — Android has no tap-gated state at all", async () => {
    mockIos = false;
    const { result } = renderHook(() => useForegroundNfcScan({ active: true, onTag: vi.fn(), label: "test" }));
    await flush();
    expect(result.current.awaitingTap).toBe(false);
  });

  it("stays open across multiple delivered tags — never auto-stops after one", async () => {
    mockIos = false;
    const onTag = vi.fn();
    const { result } = renderHook(() => useForegroundNfcScan({ active: true, onTag, label: "test" }));
    await flush();

    act(() => lastOnTag?.({ hardwareId: "AA" }));
    act(() => lastOnTag?.({ hardwareId: "BB" }));

    expect(onTag).toHaveBeenCalledTimes(2);
    expect(stopMock).not.toHaveBeenCalled();
    expect(result.current.scanning).toBe(true);
  });

  it("stops when `active` becomes false", async () => {
    mockIos = false;
    const { result, rerender } = renderHook(
      ({ active }) => useForegroundNfcScan({ active, onTag: vi.fn(), label: "test" }),
      { initialProps: { active: true } }
    );
    await flush();
    expect(result.current.scanning).toBe(true);

    rerender({ active: false });
    await flush();
    expect(stopMock).toHaveBeenCalled();
    expect(result.current.scanning).toBe(false);
  });
});

describe("useForegroundNfcScan — iOS: tap-gated, never ambient", () => {
  it("does not auto-start a session, even once supported+active", async () => {
    mockIos = true;
    const { result } = renderHook(() => useForegroundNfcScan({ active: true, onTag: vi.fn(), label: "test" }));
    await flush();

    expect(startScanSessionMock).not.toHaveBeenCalled();
    expect(result.current.scanning).toBe(false);
    expect(result.current.awaitingTap).toBe(true);
  });

  it("starts a session only once startScan() is called (simulating a tap)", async () => {
    mockIos = true;
    const { result } = renderHook(() => useForegroundNfcScan({ active: true, onTag: vi.fn(), label: "test" }));
    await flush();

    act(() => result.current.startScan());
    expect(startScanSessionMock).toHaveBeenCalledTimes(1);
    expect(result.current.scanning).toBe(true);
    expect(result.current.awaitingTap).toBe(false);
  });

  it("resets to awaitingTap after a tag is delivered — one scan per tap, never continuous", async () => {
    mockIos = true;
    const onTag = vi.fn();
    const { result } = renderHook(() => useForegroundNfcScan({ active: true, onTag, label: "test" }));
    await flush();
    act(() => result.current.startScan());
    expect(result.current.scanning).toBe(true);

    act(() => lastOnTag?.({ hardwareId: "AA" }));
    expect(onTag).toHaveBeenCalledWith({ hardwareId: "AA" });
    expect(stopMock).toHaveBeenCalled();
    expect(result.current.scanning).toBe(false);
    expect(result.current.awaitingTap).toBe(true);
  });

  it("resets to awaitingTap after an error (cancel/timeout/etc.), ready for a fresh tap", async () => {
    mockIos = true;
    const onError = vi.fn();
    const { result } = renderHook(() => useForegroundNfcScan({ active: true, onTag: vi.fn(), onError, label: "test" }));
    await flush();
    act(() => result.current.startScan());

    act(() => lastOnError?.("Scan cancelled."));
    expect(onError).toHaveBeenCalledWith("Scan cancelled.");
    expect(result.current.scanning).toBe(false);
    expect(result.current.awaitingTap).toBe(true);
  });

  it("a second startScan() call while one is already open is a no-op (no duplicate session)", async () => {
    mockIos = true;
    const { result } = renderHook(() => useForegroundNfcScan({ active: true, onTag: vi.fn(), label: "test" }));
    await flush();
    act(() => result.current.startScan());
    act(() => result.current.startScan());
    expect(startScanSessionMock).toHaveBeenCalledTimes(1);
  });

  it("awaitingTap is false when NFC isn't supported at all", async () => {
    mockIos = true;
    mockSupported = false;
    const { result } = renderHook(() => useForegroundNfcScan({ active: true, onTag: vi.fn(), label: "test" }));
    await flush();
    expect(result.current.awaitingTap).toBe(false);
  });
});
