// Defense-in-depth tests for the date/duration formatters implicated in the
// Inputs blank-screen crash: a malformed input (the literal string "null",
// an empty string, garbage text, a non-finite number) must degrade to a
// safe, labeled fallback — never throw during render.
import { describe, expect, it, vi } from "vitest";
import { combineDateAndTimeToUtcIso, formatDurationHMS, formatTimeInAppTimezone, toTimeInputValue } from "./timezone";

describe("combineDateAndTimeToUtcIso", () => {
  // <input type="time"> always emits 24-hour "HH:MM:SS" regardless of the
  // browser locale's displayed AM/PM controls — there is no code path where
  // a "5:00 PM" pick could reach this function as "05:00:00" instead of
  // "17:00:00". These lock in that the 24-hour value converts correctly
  // across a DST boundary (APP_TIMEZONE is America/Toronto).
  it("converts a 24-hour evening time (5:00 PM) during EDT to the correct UTC instant", () => {
    expect(combineDateAndTimeToUtcIso("2026-08-31", "17:00:00")).toBe("2026-08-31T21:00:00.000Z");
  });

  it("converts a 24-hour morning time (7:00 AM) during EDT to the correct UTC instant", () => {
    expect(combineDateAndTimeToUtcIso("2026-08-31", "07:00:00")).toBe("2026-08-31T11:00:00.000Z");
  });

  it("converts correctly during EST (outside daylight saving)", () => {
    expect(combineDateAndTimeToUtcIso("2026-01-15", "17:00:00")).toBe("2026-01-15T22:00:00.000Z");
  });
});

describe("formatTimeInAppTimezone", () => {
  it("formats a real ISO instant normally", () => {
    expect(formatTimeInAppTimezone("2026-08-31T04:00:00.000Z")).toMatch(/\d{1,2}:\d{2}:\d{2}\s?(AM|PM)/i);
  });

  it("never throws on the exact real-world bad shape: the literal string \"null\"", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => formatTimeInAppTimezone("null")).not.toThrow();
    expect(formatTimeInAppTimezone("null")).toBe("Unknown time");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never throws on an empty string or garbage text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => formatTimeInAppTimezone("")).not.toThrow();
    expect(() => formatTimeInAppTimezone("not-a-date")).not.toThrow();
    expect(formatTimeInAppTimezone("not-a-date")).toBe("Unknown time");
  });
});

describe("toTimeInputValue", () => {
  it("formats a real ISO instant normally", () => {
    expect(toTimeInputValue("2026-08-31T04:00:00.000Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("returns an empty string (never throws) for the literal \"null\" or other invalid input", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => toTimeInputValue("null")).not.toThrow();
    expect(toTimeInputValue("null")).toBe("");
    expect(toTimeInputValue("garbage")).toBe("");
  });
});

describe("formatDurationHMS", () => {
  it("formats a normal finite duration", () => {
    expect(formatDurationHMS(3661)).toBe("1:01:01");
  });

  it("treats NaN/Infinity as zero instead of rendering NaN:NaN:NaN", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(formatDurationHMS(NaN)).toBe("0:00:00");
    expect(formatDurationHMS(Infinity)).toBe("0:00:00");
    expect(formatDurationHMS(-Infinity)).toBe("0:00:00");
  });

  it("clamps a negative finite duration to zero (unchanged prior behavior)", () => {
    expect(formatDurationHMS(-5)).toBe("0:00:00");
  });
});
