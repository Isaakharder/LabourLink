import { beforeAll, describe, expect, it } from "vitest";
import { ScannedTag } from "./nfc";
import type { CachedTagMapping } from "./nfcMappingCache";

// nfcMappingCache.ts imports lib/api.ts, whose module-level resolveApiUrl()
// reads `window.location` under Vite dev mode — same stub-before-import
// api.test.ts already uses, for the same reason.
let resolveTagAgainstMappings: typeof import("./nfcMappingCache").resolveTagAgainstMappings;

beforeAll(async () => {
  (globalThis as { window?: unknown }).window ??= { location: { protocol: "http:", hostname: "localhost" } };
  ({ resolveTagAgainstMappings } = await import("./nfcMappingCache"));
});

function scan(overrides: Partial<ScannedTag> = {}): ScannedTag {
  return {
    hardwareId: "048E7BE2202290",
    labourlinkTagUuid: null,
    hasNdefData: false,
    isWritable: null,
    maxSize: null,
    ...overrides,
  };
}

function mapping(overrides: Partial<CachedTagMapping> = {}): CachedTagMapping {
  return {
    targetType: "greenhouse_row",
    targetId: "row-1",
    label: "Phase A · Row 1",
    labourlinkTagUuid: null,
    ridderHardwareId: null,
    ...overrides,
  };
}

describe("resolveTagAgainstMappings", () => {
  it("resolves by hardware ID (Ridder tag)", () => {
    const mappings = [mapping({ ridderHardwareId: "048E7BE2202290" })];
    expect(resolveTagAgainstMappings(scan(), mappings)).toEqual({
      targetType: "greenhouse_row",
      targetId: "row-1",
      label: "Phase A · Row 1",
    });
  });

  it("prefers a LabourLink UUID match over a hardware ID match when both are present", () => {
    const tag = scan({ hardwareId: "048E7BE2202290", labourlinkTagUuid: "12345678-1234-1234-1234-123456789abc" });
    const mappings = [
      mapping({ targetId: "row-wrong", ridderHardwareId: "048E7BE2202290" }),
      mapping({ targetId: "row-right", labourlinkTagUuid: "12345678-1234-1234-1234-123456789abc" }),
    ];
    expect(resolveTagAgainstMappings(tag, mappings)?.targetId).toBe("row-right");
  });

  it("falls back to hardware ID when the LabourLink UUID isn't mapped", () => {
    const tag = scan({ hardwareId: "048E7BE2202290", labourlinkTagUuid: "12345678-1234-1234-1234-123456789abc" });
    const mappings = [mapping({ ridderHardwareId: "048E7BE2202290" })];
    expect(resolveTagAgainstMappings(tag, mappings)?.targetId).toBe("row-1");
  });

  it("returns null for a tag matching nothing in the cache", () => {
    expect(resolveTagAgainstMappings(scan({ hardwareId: "UNKNOWN" }), [mapping({ ridderHardwareId: "048E7BE2202290" })])).toBeNull();
  });

  it("returns null against an empty cache (e.g. offline before the first successful fetch)", () => {
    expect(resolveTagAgainstMappings(scan(), [])).toBeNull();
  });

  it("matches a carrier ('bin') mapping the same way", () => {
    const mappings = [mapping({ targetType: "carrier", targetId: "carrier-1", label: "Bin 3", ridderHardwareId: "048E7BE2202290" })];
    expect(resolveTagAgainstMappings(scan(), mappings)).toEqual({ targetType: "carrier", targetId: "carrier-1", label: "Bin 3" });
  });
});
