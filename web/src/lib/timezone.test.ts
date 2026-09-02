// Defense-in-depth tests for the date/duration formatters implicated in the
// Inputs blank-screen crash: a malformed input (the literal string "null",
// an empty string, garbage text, a non-finite number) must degrade to a
// safe, labeled fallback — never throw during render.
import { describe, expect, it, vi } from "vitest";
import { formatDurationHMS, formatTimeInAppTimezone, toTimeInputValue } from "./timezone";

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
