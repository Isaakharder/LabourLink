// @vitest-environment jsdom
// feedback.ts reads `window`/`navigator` directly — needs a real DOM global
// to mock AudioContext/vibrate against, unlike most of this directory's
// pure-logic tests (see vite.config.ts's own comment on why jsdom is opt-in
// per file rather than the default).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playErrorFeedback, playSuccessFeedback } from "./feedback";

// feedback.ts synthesizes tones with the Web Audio API, which jsdom doesn't
// implement — these mocks stand in for AudioContext/navigator.vibrate just
// well enough to assert call counts and the gain/vibration values that
// actually distinguish "louder success" from "softer error" (the concrete
// levers feedback.ts exposes), without needing a real browser.
class MockOscillator {
  frequency = { value: 0 };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockGain {
  gain = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}

class MockAudioContext {
  currentTime = 0;
  destination = {};
  oscillators: MockOscillator[] = [];
  gains: MockGain[] = [];
  createOscillator() {
    const osc = new MockOscillator();
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    const gain = new MockGain();
    this.gains.push(gain);
    return gain;
  }
}

let vibrateMock: ReturnType<typeof vi.fn>;
let audioContextMock: MockAudioContext;

function installAudioMocks() {
  vibrateMock = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: vibrateMock, configurable: true, writable: true });

  audioContextMock = new MockAudioContext();
  (window as unknown as { AudioContext?: unknown }).AudioContext = vi.fn(() => audioContextMock);
}

function removeAudioMocks() {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  // @ts-expect-error test-only cleanup of a property installed for this suite
  delete navigator.vibrate;
}

beforeEach(installAudioMocks);
afterEach(removeAudioMocks);

// The peak gain the pre-existing single-tone implementation used — the
// concrete "how loud is success now" regression guard: every assertion
// below that success must be louder compares against this exact prior
// value, not just an arbitrary threshold.
const PREVIOUS_SUCCESS_PEAK_GAIN = 0.15;

function peakGainOf(gain: MockGain): number {
  // exponentialRampToValueAtTime is called twice per tone (ramp up to
  // peak, then back down to near-silent) — the first call is the peak.
  return gain.gain.exponentialRampToValueAtTime.mock.calls[0][0];
}

describe("playSuccessFeedback", () => {
  it("vibrates exactly once per call", () => {
    playSuccessFeedback();
    expect(vibrateMock).toHaveBeenCalledTimes(1);
    expect(vibrateMock).toHaveBeenCalledWith(80);
  });

  it("plays exactly two rising tones — a louder, more distinct chime than a single soft beep", () => {
    playSuccessFeedback();
    expect(audioContextMock.oscillators).toHaveLength(2);
    expect(audioContextMock.oscillators[0].frequency.value).toBe(880);
    expect(audioContextMock.oscillators[1].frequency.value).toBeGreaterThan(audioContextMock.oscillators[0].frequency.value);
  });

  it("is louder than the previous implementation's peak gain (0.15)", () => {
    playSuccessFeedback();
    for (const gain of audioContextMock.gains) {
      expect(peakGainOf(gain)).toBeGreaterThan(PREVIOUS_SUCCESS_PEAK_GAIN);
    }
  });

  it("each call produces its own fresh tones — one call's sound doesn't compound with another's", () => {
    playSuccessFeedback();
    playSuccessFeedback();
    expect(audioContextMock.oscillators).toHaveLength(4);
    expect(vibrateMock).toHaveBeenCalledTimes(2);
  });

  it("never throws when AudioContext/vibrate are unavailable on this device", () => {
    removeAudioMocks();
    expect(() => playSuccessFeedback()).not.toThrow();
  });
});

describe("playErrorFeedback", () => {
  it("vibrates with a distinct double-buzz pattern, not success's single buzz", () => {
    playErrorFeedback();
    expect(vibrateMock).toHaveBeenCalledTimes(1);
    expect(vibrateMock).toHaveBeenCalledWith([60, 60, 60]);
  });

  it("plays exactly one tone, softer than success's peak gain", () => {
    playSuccessFeedback();
    const successPeak = peakGainOf(audioContextMock.gains[0]);
    removeAudioMocks();
    installAudioMocks();

    playErrorFeedback();
    expect(audioContextMock.oscillators).toHaveLength(1);
    expect(peakGainOf(audioContextMock.gains[0])).toBeLessThan(successPeak);
  });

  it("never throws when AudioContext/vibrate are unavailable on this device", () => {
    removeAudioMocks();
    expect(() => playErrorFeedback()).not.toThrow();
  });
});
