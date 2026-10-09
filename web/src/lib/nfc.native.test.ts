// Native-platform coverage for lib/nfc.ts's startScanSession — nfc.test.ts
// covers the pure/non-native logic (isNativePlatform() is false under plain
// Node/no-Capacitor, so that file's calls never reach the branches this
// file targets). This mocks both @capacitor/core (so isNativePlatform()/
// isIosNativePlatform() report a real native platform) and
// @capgo/capacitor-nfc (so the exact options object passed to
// startScanning(), and the nfcEvent/nfcSessionEnd listener wiring, can be
// asserted directly) — same "mock the plugin, not the wrapper" convention
// as localEventStore.native.test.ts.
//
// Each test calls loadNfc() to get a FRESH nfc.ts module instance (via
// vi.resetModules() + a fresh dynamic import) rather than sharing one
// import across the whole file — nfc.ts keeps a module-level `activeStop`
// singleton (by design: only one reader session may ever be active), and
// sharing that singleton across many independent test cases here proved
// order/timing-sensitive once this file ran alongside the rest of the
// suite instead of alone. A fresh module per test sidesteps that
// entirely rather than relying on precise flush timing.
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockPlatform: "ios" | "android" = "android";
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => mockPlatform,
  },
}));

type Listener = (event: unknown) => void;
let listeners: Record<string, Listener[]>;
const startScanningMock = vi.fn().mockResolvedValue(undefined);
const stopScanningMock = vi.fn().mockResolvedValue(undefined);
const removeMock = vi.fn().mockResolvedValue(undefined);
// Actually splices the callback out of `listeners` on remove() — not just a
// spy — so a test emitting an event after stop() has had time to run
// genuinely proves the listener is gone, the same guarantee the real
// plugin's addListener()/PluginListenerHandle.remove() gives.
const addListenerMock = vi.fn((eventName: string, cb: Listener) => {
  (listeners[eventName] ??= []).push(cb);
  return Promise.resolve({
    remove: () => {
      listeners[eventName] = (listeners[eventName] ?? []).filter((registered) => registered !== cb);
      return removeMock();
    },
  });
});

vi.mock("@capgo/capacitor-nfc", () => ({
  CapacitorNfc: {
    startScanning: (...args: unknown[]) => startScanningMock(...args),
    stopScanning: (...args: unknown[]) => stopScanningMock(...args),
    addListener: (...args: [string, Listener]) => addListenerMock(...args),
  },
}));

async function loadNfc() {
  vi.resetModules();
  return import("./nfc");
}

function emit(eventName: string, event: unknown) {
  for (const cb of listeners[eventName] ?? []) cb(event);
}

// Polls (rather than a fixed number of setTimeout(0) ticks) until the given
// condition is true or a generous budget is exhausted — robust regardless
// of how much unrelated work (other test files' timers, in this Vitest
// pool) shares the event loop.
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

beforeEach(() => {
  listeners = {};
  mockPlatform = "android";
  startScanningMock.mockClear();
  startScanningMock.mockResolvedValue(undefined);
  stopScanningMock.mockClear();
  addListenerMock.mockClear();
  removeMock.mockClear();
});

function iosTag() {
  return { id: [0x04, 0xa1, 0x0f], techTypes: [], ndefMessage: null, isWritable: null, maxSize: null };
}

describe("startScanSession — Android options are exactly preserved", () => {
  it("calls startScanning with invalidateAfterFirstRead:false and the existing androidReaderModeFlags, nothing iOS-specific", async () => {
    mockPlatform = "android";
    const { startScanSession, ANDROID_READER_MODE_FLAGS } = await loadNfc();
    const stop = startScanSession(() => {}, undefined, "test");
    await waitUntil(() => startScanningMock.mock.calls.length > 0);
    expect(startScanningMock).toHaveBeenCalledTimes(1);
    expect(startScanningMock).toHaveBeenCalledWith({
      invalidateAfterFirstRead: false,
      androidReaderModeFlags: ANDROID_READER_MODE_FLAGS,
    });
    stop();
  });

  it("ignores a caller-supplied iosAlertMessage on Android — never sent to the native call", async () => {
    mockPlatform = "android";
    const { startScanSession } = await loadNfc();
    const stop = startScanSession(() => {}, undefined, "test", "Some iOS-only text");
    await waitUntil(() => startScanningMock.mock.calls.length > 0);
    const call = startScanningMock.mock.calls[0][0];
    expect(call).not.toHaveProperty("alertMessage");
    expect(call).not.toHaveProperty("iosSessionType");
    stop();
  });
});

describe("startScanSession — iOS options", () => {
  it("uses iosSessionType 'tag' and invalidateAfterFirstRead:true", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const stop = startScanSession(() => {}, undefined, "test");
    await waitUntil(() => startScanningMock.mock.calls.length > 0);
    expect(startScanningMock).toHaveBeenCalledTimes(1);
    const call = startScanningMock.mock.calls[0][0];
    expect(call.iosSessionType).toBe("tag");
    expect(call.invalidateAfterFirstRead).toBe(true);
    expect(call).not.toHaveProperty("androidReaderModeFlags");
    stop();
  });

  it("passes a caller-supplied alertMessage through verbatim", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const stop = startScanSession(() => {}, undefined, "test", "Hold near the row tag to switch.");
    await waitUntil(() => startScanningMock.mock.calls.length > 0);
    expect(startScanningMock.mock.calls[0][0].alertMessage).toBe("Hold near the row tag to switch.");
    stop();
  });

  it("falls back to DEFAULT_IOS_ALERT_MESSAGE when no alertMessage is supplied", async () => {
    mockPlatform = "ios";
    const { startScanSession, DEFAULT_IOS_ALERT_MESSAGE } = await loadNfc();
    const stop = startScanSession(() => {}, undefined, "test");
    await waitUntil(() => startScanningMock.mock.calls.length > 0);
    expect(startScanningMock.mock.calls[0][0].alertMessage).toBe(DEFAULT_IOS_ALERT_MESSAGE);
    stop();
  });
});

describe("startScanSession — iOS is a single-read session (regression: physical iPhone report of Apple's 'Ready to Scan' sheet staying open after a successful scan)", () => {
  it("calls native stopScanning() itself right after the first tag event — never assumes the native session already tore itself down", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onTag = vi.fn();
    const stop = startScanSession(onTag, undefined, "test");
    await waitUntil(() => (listeners["nfcEvent"] ?? []).length > 0);

    // Baseline rather than asserting "never called at all": nfc.ts keeps a
    // module-level activeStop singleton, and this mock function is shared
    // (not reset) across the fresh nfc.ts module instances loadNfc() hands
    // out per test — an unrelated prior test's own async stop() chain can
    // still resolve a tick into this one. What this test actually needs to
    // prove is the DELTA: stopScanning() fires as a direct result of THIS
    // session's first tag event, not merely "at some point".
    const callsBeforeEmit = stopScanningMock.mock.calls.length;
    emit("nfcEvent", { type: "tag", tag: iosTag() });
    expect(onTag).toHaveBeenCalledTimes(1);
    await waitUntil(() => stopScanningMock.mock.calls.length > callsBeforeEmit);
    expect(stopScanningMock.mock.calls.length).toBe(callsBeforeEmit + 1);
    stop();
  });

  it("removes its own nfcEvent listener once stopped — a later event (e.g. a stray native callback) can no longer reach onTag a second time", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onTag = vi.fn();
    const stop = startScanSession(onTag, undefined, "test");
    await waitUntil(() => (listeners["nfcEvent"] ?? []).length > 0);

    emit("nfcEvent", { type: "tag", tag: iosTag() });
    expect(onTag).toHaveBeenCalledTimes(1);
    // Wait for the auto-stop's own async cleanup (listenerHandle.remove())
    // to actually finish before proving the listener is gone.
    await waitUntil(() => (listeners["nfcEvent"] ?? []).length === 0);

    emit("nfcEvent", { type: "tag", tag: { ...iosTag(), id: [0xaa, 0xbb] } });
    expect(onTag).toHaveBeenCalledTimes(1);
    stop();
  });

  it("calls native stopScanning() on cleanup/navigation even if no tag was ever read", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const stop = startScanSession(() => {}, undefined, "test");
    await waitUntil(() => startScanningMock.mock.calls.length > 0);

    const callsBeforeStop = stopScanningMock.mock.calls.length;
    stop();
    await waitUntil(() => stopScanningMock.mock.calls.length > callsBeforeStop);
    expect(stopScanningMock.mock.calls.length).toBe(callsBeforeStop + 1);
  });

  it("Android is NOT affected — receiving a tag event never triggers an automatic stopScanning() call, preserving ambient continuous scanning", async () => {
    mockPlatform = "android";
    const { startScanSession } = await loadNfc();
    const onTag = vi.fn();
    const callsBeforeStart = stopScanningMock.mock.calls.length;
    const stop = startScanSession(onTag, undefined, "test");
    await waitUntil(() => (listeners["nfcEvent"] ?? []).length > 0);

    emit("nfcEvent", { type: "tag", tag: iosTag() });
    emit("nfcEvent", { type: "tag", tag: { ...iosTag(), id: [0xaa, 0xbb] } });
    expect(onTag).toHaveBeenCalledTimes(2);
    // Still zero NEW stopScanning() calls from receiving tag events — the
    // ambient session must stay open across many tags. stop()'s own
    // eventual call below is excluded by comparing against the baseline
    // taken before any of this ran.
    expect(stopScanningMock.mock.calls.length).toBe(callsBeforeStart);
    stop();
  });
});

describe("startScanSession — iOS nfcSessionEnd handling", () => {
  it("does not call onError when nfcSessionEnd fires after a successful tag read (session closing itself is not a failure)", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onTag = vi.fn();
    const onError = vi.fn();
    const stop = startScanSession(onTag, onError, "test");
    await waitUntil(() => (listeners["nfcEvent"] ?? []).length > 0 && (listeners["nfcSessionEnd"] ?? []).length > 0);

    emit("nfcEvent", { type: "tag", tag: iosTag() });
    expect(onTag).toHaveBeenCalledTimes(1);

    emit("nfcSessionEnd", { reason: "invalidated" });
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("calls onError with a clear message when the session ends before any tag was read", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onError = vi.fn();
    const stop = startScanSession(() => {}, onError, "test");
    await waitUntil(() => (listeners["nfcSessionEnd"] ?? []).length > 0);

    emit("nfcSessionEnd", { reason: "userCancelled" });
    expect(onError).toHaveBeenCalledWith("Scan cancelled.");
    stop();
  });

  it("maps sessionTimeout to a clear, distinct message", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onError = vi.fn();
    const stop = startScanSession(() => {}, onError, "test");
    await waitUntil(() => (listeners["nfcSessionEnd"] ?? []).length > 0);

    emit("nfcSessionEnd", { reason: "sessionTimeout" });
    expect(onError).toHaveBeenCalledWith("Scan timed out — tap Scan again to try.");
    stop();
  });

  it("maps a generic 'invalidated' reason (e.g. multiple tags presented) to actionable guidance", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onError = vi.fn();
    const stop = startScanSession(() => {}, onError, "test");
    await waitUntil(() => (listeners["nfcSessionEnd"] ?? []).length > 0);

    emit("nfcSessionEnd", { reason: "invalidated" });
    expect(onError).toHaveBeenCalledWith("Scan didn't complete — make sure only one tag is near the phone, then try again.");
    stop();
  });

  it("suppresses nfcSessionEnd entirely once the caller has already called stop() itself", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onError = vi.fn();
    const stop = startScanSession(() => {}, onError, "test");
    await waitUntil(() => (listeners["nfcSessionEnd"] ?? []).length > 0);

    stop();
    await waitUntil(() => stopScanningMock.mock.calls.length > 0);
    emit("nfcSessionEnd", { reason: "invalidated" });
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("startScanSession — startScanning rejection (unsupported device / missing entitlement / simulator)", () => {
  it("forwards the native plugin's own error message verbatim, unmodified", async () => {
    mockPlatform = "ios";
    startScanningMock.mockRejectedValueOnce(
      new Error("NFC tag reading is not available on this device. Ensure the TAG reader entitlement is enabled.")
    );
    const { startScanSession } = await loadNfc();
    const onError = vi.fn();
    const stop = startScanSession(() => {}, onError, "test");
    await waitUntil(() => onError.mock.calls.length > 0);
    expect(onError).toHaveBeenCalledWith(
      "NFC tag reading is not available on this device. Ensure the TAG reader entitlement is enabled."
    );
    stop();
  });
});

describe("startScanSession — actual iOS native event shape", () => {
  // Encodes the plugin's real iOS event structure exactly as
  // NfcPlugin.swift's emitTagEvent()/buildEvent() construct it (see
  // node_modules/@capgo/capacitor-nfc/ios/Sources/NfcPlugin/NfcPlugin.swift
  // — tagInfo["id"] is only ever set when extractIdentifier() returns
  // non-nil; every other key is set unconditionally). This is the ACTUAL
  // schema, not a simplified stand-in — asserting against it is what makes
  // these regression tests, not just tests of toScannedTag()'s own
  // assumptions about its input.

  it("REGRESSION — physical iPhone Row 2 scan: ndef present, isWritable true, but no raw id at all (extractIdentifier returned nil)", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onTag = vi.fn();
    const stop = startScanSession(onTag, undefined, "test");
    await waitUntil(() => (listeners["nfcEvent"] ?? []).length > 0);

    // Swift's `if let identifierData = extractIdentifier(...) { tagInfo["id"] = ... }`
    // means the "id" key is ENTIRELY ABSENT from the JSON the plugin sends
    // when extraction fails — never present as an empty array. This event
    // omits `id` for exactly that reason (not `id: []`, which would be a
    // different, not-yet-observed native condition).
    emit("nfcEvent", {
      type: "ndef",
      tag: {
        techTypes: ["NFCMiFareTag"],
        isWritable: true,
        maxSize: 137,
        type: "MIFARE Ultralight",
        ndefMessage: [{ tnf: 1, type: [0x55], id: [], payload: [0, 108, 97, 98, 111, 117, 114, 108, 105, 110, 107] }],
      },
    });

    expect(onTag).toHaveBeenCalledTimes(1);
    const tag = onTag.mock.calls[0][0];
    expect(tag.hardwareId).toBe("");
    expect(tag.rawId).toBeNull();
    expect(tag.hasNdefData).toBe(true);
    expect(tag.isWritable).toBe(true);
    expect(tag.maxSize).toBe(137);
    expect(tag.techTypes).toEqual(["NFCMiFareTag"]);
    expect(tag.tagType).toBe("MIFARE Ultralight");
    expect(tag.ndefRecords).toHaveLength(1);
    expect(tag.ndefRecords[0].payload).toEqual([0, 108, 97, 98, 111, 117, 114, 108, 105, 110, 107]);
    // Not LabourLink's own v1 URI format (no "labourlink://tag/v1/" prefix
    // byte sequence) — correctly unparsed, not a bug in parseLabourlinkTagUuid.
    expect(tag.labourlinkTagUuid).toBeNull();
    stop();
  });

  it("when extraction succeeds, hardwareId/rawId are populated and every leading-zero byte is preserved", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onTag = vi.fn();
    const stop = startScanSession(onTag, undefined, "test");
    await waitUntil(() => (listeners["nfcEvent"] ?? []).length > 0);

    emit("nfcEvent", {
      type: "tag",
      tag: {
        id: [0x00, 0x01, 0x0a],
        techTypes: ["NFCMiFareTag"],
        isWritable: true,
        maxSize: 137,
        type: "MIFARE Ultralight",
      },
    });

    const tag = onTag.mock.calls[0][0];
    expect(tag.rawId).toEqual([0x00, 0x01, 0x0a]);
    // Same guarantee lib/nfcTagId.test.ts pins directly — no byte dropped,
    // no leading zero silently absorbed by a numeric round-trip.
    expect(tag.hardwareId).toBe("00010A");
    stop();
  });

  it("a blank/unformatted tag (no NDEF message at all) still surfaces techTypes/tagType/isWritable even with hasNdefData false", async () => {
    mockPlatform = "ios";
    const { startScanSession } = await loadNfc();
    const onTag = vi.fn();
    const stop = startScanSession(onTag, undefined, "test");
    await waitUntil(() => (listeners["nfcEvent"] ?? []).length > 0);

    emit("nfcEvent", {
      type: "tag",
      tag: { id: [0x04, 0x8e, 0x7b], techTypes: ["NFCMiFareTag"], isWritable: true, maxSize: 137, type: "MIFARE Ultralight" },
    });

    const tag = onTag.mock.calls[0][0];
    expect(tag.hasNdefData).toBe(false);
    expect(tag.ndefRecords).toEqual([]);
    expect(tag.hardwareId).toBe("048E7B");
    stop();
  });
});
