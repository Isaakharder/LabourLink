import { describe, expect, it } from "vitest";
import { computeRoundingExample } from "./workStartRoundingExample";

describe("computeRoundingExample", () => {
  it("shows the exact spec example for a 5-minute interval, clockwise", () => {
    const rows = computeRoundingExample(5, "clockwise");
    expect(rows).toEqual([
      { inputLabel: "7:00 AM", outputLabel: "7:00 AM" },
      { inputLabel: "7:01 AM", outputLabel: "7:05 AM" },
      { inputLabel: "7:04 AM", outputLabel: "7:05 AM" },
    ]);
  });

  it("shows the exact spec example for a 5-minute interval, counter-clockwise", () => {
    const rows = computeRoundingExample(5, "counter_clockwise");
    expect(rows).toEqual([
      { inputLabel: "7:00 AM", outputLabel: "7:00 AM" },
      { inputLabel: "7:01 AM", outputLabel: "7:00 AM" },
      { inputLabel: "7:04 AM", outputLabel: "7:00 AM" },
    ]);
  });

  it("handles an arbitrary interval that doesn't evenly divide an hour", () => {
    const rows = computeRoundingExample(7, "clockwise");
    expect(rows).toEqual([
      { inputLabel: "7:00 AM", outputLabel: "7:00 AM" },
      { inputLabel: "7:01 AM", outputLabel: "7:07 AM" },
      { inputLabel: "7:06 AM", outputLabel: "7:07 AM" },
    ]);
  });

  it("handles an hour-boundary interval (60 minutes)", () => {
    const rows = computeRoundingExample(60, "clockwise");
    expect(rows).toEqual([
      { inputLabel: "7:00 AM", outputLabel: "7:00 AM" },
      { inputLabel: "7:01 AM", outputLabel: "8:00 AM" },
      { inputLabel: "7:59 AM", outputLabel: "8:00 AM" },
    ]);
  });

  it("collapses to a single always-exact row for a 1-minute interval", () => {
    expect(computeRoundingExample(1, "clockwise")).toEqual([{ inputLabel: "7:11 AM", outputLabel: "7:11 AM" }]);
    expect(computeRoundingExample(1, "counter_clockwise")).toEqual([
      { inputLabel: "7:11 AM", outputLabel: "7:11 AM" },
    ]);
  });

  it("returns no rows for an out-of-range interval", () => {
    expect(computeRoundingExample(0, "clockwise")).toEqual([]);
    expect(computeRoundingExample(61, "clockwise")).toEqual([]);
    expect(computeRoundingExample(5.5, "clockwise")).toEqual([]);
  });
});
