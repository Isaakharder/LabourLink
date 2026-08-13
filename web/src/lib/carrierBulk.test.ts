import { describe, expect, it } from "vitest";
import { buildBulkCarrierNames, normalizeCarrierName, padCarrierNumber } from "./carrierBulk";

describe("padCarrierNumber", () => {
  it("pads to the requested width", () => {
    expect(padCarrierNumber(1, 3)).toBe("001");
    expect(padCarrierNumber(50, 3)).toBe("050");
  });

  it("never truncates a number wider than the padding", () => {
    expect(padCarrierNumber(100, 2)).toBe("100");
  });

  it("uses the natural string when padding is null or 0", () => {
    expect(padCarrierNumber(7, null)).toBe("7");
    expect(padCarrierNumber(7, 0)).toBe("7");
  });
});

describe("buildBulkCarrierNames", () => {
  it("matches the feature request's example", () => {
    expect(buildBulkCarrierNames("Bin", 1, 3, 3)).toEqual(["Bin 001", "Bin 002", "Bin 003"]);
  });

  it("creates 50 names for a 1..50 range with padding 3", () => {
    const names = buildBulkCarrierNames("Bin", 1, 50, 3);
    expect(names).toHaveLength(50);
    expect(names[0]).toBe("Bin 001");
    expect(names[49]).toBe("Bin 050");
  });

  it("creates exactly one name when start === end", () => {
    expect(buildBulkCarrierNames("Carrier", 5, 5, null)).toEqual(["Carrier 5"]);
  });

  it("never produces intra-batch duplicates", () => {
    const names = buildBulkCarrierNames("Bin", 1, 100, null);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("normalizeCarrierName", () => {
  it("trims and lowercases", () => {
    expect(normalizeCarrierName("  Bin 001  ")).toBe("bin 001");
  });
});
