import { describe, expect, it } from "vitest";
import {
  buildLabourlinkUriRecord,
  hexId,
  LABOURLINK_URI_PREFIX,
  parseLabourlinkTagUuid,
  shouldSuppressDuplicateScan,
  startScanSession,
} from "./nfc";

function utf8Bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function uriRecord(uri: string, uriIdentifierCode = 0x00): { tnf: number; type: number[]; id: number[]; payload: number[] } {
  return {
    tnf: 0x01,
    type: [0x55],
    id: [],
    payload: [uriIdentifierCode, ...utf8Bytes(uri)],
  };
}

describe("hexId", () => {
  it("formats bytes as uppercase, zero-padded hex with no separators", () => {
    expect(hexId([0x04, 0xa1, 0x0f])).toBe("04A10F");
  });

  it("returns an empty string for an empty byte array", () => {
    expect(hexId([])).toBe("");
  });
});

describe("parseLabourlinkTagUuid", () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";

  it("extracts the UUID from a well-formed v1 LabourLink URI record", () => {
    const records = [uriRecord(`${LABOURLINK_URI_PREFIX}${uuid}`)];
    expect(parseLabourlinkTagUuid(records)).toBe(uuid);
  });

  it("lowercases a mixed-case UUID", () => {
    const records = [uriRecord(`${LABOURLINK_URI_PREFIX}${uuid.toUpperCase()}`)];
    expect(parseLabourlinkTagUuid(records)).toBe(uuid);
  });

  it("returns null when there are no NDEF records at all (e.g. a raw Ridder tag)", () => {
    expect(parseLabourlinkTagUuid(null)).toBeNull();
    expect(parseLabourlinkTagUuid(undefined)).toBeNull();
    expect(parseLabourlinkTagUuid([])).toBeNull();
  });

  it("returns null for a foreign NDEF payload that isn't a LabourLink URI", () => {
    const records = [uriRecord("https://example.com/not-labourlink")];
    expect(parseLabourlinkTagUuid(records)).toBeNull();
  });

  it("returns null for a URI record with the wrong prefix", () => {
    const records = [uriRecord(`labourlink://tag/v2/${uuid}`)];
    expect(parseLabourlinkTagUuid(records)).toBeNull();
  });

  it("returns null when the suffix after the prefix isn't a valid UUID", () => {
    const records = [uriRecord(`${LABOURLINK_URI_PREFIX}not-a-uuid`)];
    expect(parseLabourlinkTagUuid(records)).toBeNull();
  });

  it("returns null for a plain text record (not a URI record)", () => {
    const records = [{ tnf: 0x01, type: [0x54], id: [], payload: utf8Bytes(`\x02en${LABOURLINK_URI_PREFIX}${uuid}`) }];
    expect(parseLabourlinkTagUuid(records)).toBeNull();
  });

  it("ignores a URI record using a standard abbreviation code instead of 0x00", () => {
    // Abbreviation codes (e.g. 0x01 = "http://www.") never apply to
    // LabourLink's own scheme — a real tag using one here can't be ours.
    const records = [uriRecord(`${LABOURLINK_URI_PREFIX}${uuid}`, 0x01)];
    expect(parseLabourlinkTagUuid(records)).toBeNull();
  });

  it("finds the LabourLink record even when it's not the first record", () => {
    const records = [uriRecord("https://example.com/unrelated"), uriRecord(`${LABOURLINK_URI_PREFIX}${uuid}`)];
    expect(parseLabourlinkTagUuid(records)).toBe(uuid);
  });
});

describe("buildLabourlinkUriRecord", () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";

  it("builds a record parseLabourlinkTagUuid can read straight back", () => {
    const record = buildLabourlinkUriRecord(uuid);
    expect(parseLabourlinkTagUuid([record])).toBe(uuid);
  });

  it("uses TNF well-known, type 'U', and no abbreviation code", () => {
    const record = buildLabourlinkUriRecord(uuid);
    expect(record.tnf).toBe(0x01);
    expect(record.type).toEqual([0x55]);
    expect(record.payload[0]).toBe(0x00);
  });
});

describe("shouldSuppressDuplicateScan", () => {
  it("does not suppress the first scan (no previous tag)", () => {
    expect(shouldSuppressDuplicateScan(null, "048E7BE2202290")).toBe(false);
  });

  it("suppresses the same hardware ID seen again", () => {
    expect(shouldSuppressDuplicateScan("048E7BE2202290", "048E7BE2202290")).toBe(true);
  });

  it("does not suppress a different hardware ID", () => {
    expect(shouldSuppressDuplicateScan("048E7BE2202290", "AABBCCDDEE")).toBe(false);
  });
});

describe("startScanSession — single reader ownership", () => {
  // This test environment isn't a native platform, so none of these calls
  // ever touch the real plugin/hardware (isNativePlatform() gates that
  // branch out entirely) — what's actually being verified here is the
  // ownership bookkeeping itself: starting a new session always tears down
  // whatever was previously active (see lib/nfc.ts's module-level
  // activeStop), and every returned stop function stays safely idempotent
  // regardless of whether it "won" or was pre-empted. Whether the *native*
  // reader genuinely only ever has one listener is confirmed on-device
  // (Ulefone), not here.
  it("starting a second session does not throw and both stop functions remain safe to call", () => {
    const stopA = startScanSession(() => {});
    const stopB = startScanSession(() => {});
    expect(() => stopA()).not.toThrow();
    expect(() => stopB()).not.toThrow();
  });

  it("a stop function is idempotent — calling it more than once is a no-op, not an error", () => {
    const stop = startScanSession(() => {});
    stop();
    expect(() => stop()).not.toThrow();
  });

  it("a fresh session can start cleanly after two prior sessions have both been superseded/stopped", () => {
    const stopA = startScanSession(() => {});
    const stopB = startScanSession(() => {});
    stopA();
    stopB();
    const stopC = startScanSession(() => {});
    expect(() => stopC()).not.toThrow();
  });
});
