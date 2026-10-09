import { describe, expect, it } from "vitest";
import { bytesToHex, isSameTagIdAnyByteOrder, normalizeTagId } from "./nfcTagId";

describe("bytesToHex", () => {
  it("formats bytes as uppercase, zero-padded hex with no separators", () => {
    expect(bytesToHex([0x04, 0xa1, 0x0f])).toBe("04A10F");
  });

  it("zero-pads single-digit bytes (leading zeros)", () => {
    expect(bytesToHex([0x00, 0x01, 0x0a])).toBe("00010A");
  });

  it("returns an empty string for an empty byte array", () => {
    expect(bytesToHex([])).toBe("");
  });

  it("masks values outside a single byte (defensive — a real UID byte is always 0-255)", () => {
    expect(bytesToHex([0x104])).toBe("04");
  });
});

describe("normalizeTagId — byte arrays", () => {
  it("normalizes a byte array the same way bytesToHex does", () => {
    expect(normalizeTagId([0x04, 0x8e, 0x7b, 0xe2, 0x20, 0x22, 0x90])).toBe("048E7BE2202290");
  });
});

describe("normalizeTagId — string input: case", () => {
  it("uppercases a lowercase hex string", () => {
    expect(normalizeTagId("048e7be2202290")).toBe("048E7BE2202290");
  });

  it("leaves an already-uppercase hex string unchanged", () => {
    expect(normalizeTagId("048E7BE2202290")).toBe("048E7BE2202290");
  });

  it("normalizes mixed-case input", () => {
    expect(normalizeTagId("04A1b2C3d4E5f6")).toBe("04A1B2C3D4E5F6");
  });
});

describe("normalizeTagId — leading zeros", () => {
  it("preserves a leading zero byte in a byte array", () => {
    expect(normalizeTagId([0x00, 0xa1, 0x0f])).toBe("00A10F");
  });

  it("preserves a leading zero already present in a string", () => {
    expect(normalizeTagId("00a10f")).toBe("00A10F");
  });
});

describe("normalizeTagId — separators", () => {
  it("strips colon separators (common human-readable MAC/UID formatting)", () => {
    expect(normalizeTagId("04:8E:7B:E2:20:22:90")).toBe("048E7BE2202290");
  });

  it("strips hyphen separators", () => {
    expect(normalizeTagId("04-8E-7B-E2-20-22-90")).toBe("048E7BE2202290");
  });

  it("strips internal and surrounding whitespace", () => {
    expect(normalizeTagId("  04 8E 7B E2 20 22 90  ")).toBe("048E7BE2202290");
  });

  it("strips a mix of separators in one string", () => {
    expect(normalizeTagId(" 04:8e-7B e2")).toBe("048E7BE2");
  });

  // Regression guard for a real concern raised about this function: a
  // leading zero BYTE (0x00, distinct from a leading zero DIGIT within a
  // later byte like 0x0A) must never be silently dropped the way it would
  // be if the string were ever round-tripped through a numeric parse
  // (Number("000102") === 102, i.e. "102" — exactly the corruption this
  // function must never produce). normalizeTagId never parses its input as
  // a number at any point — separators are stripped with a plain
  // string.replace, never Number()/parseInt()/BigInt() — so this holds by
  // construction, not by coincidence; this test pins that guarantee for
  // every input shape the function accepts.
  it("never drops a leading zero byte — colon-separated string form", () => {
    expect(normalizeTagId("00:01:0A")).toBe("00010A");
  });

  it("never drops a leading zero byte — hyphen-separated string form", () => {
    expect(normalizeTagId("00-01-0a")).toBe("00010A");
  });

  it("never drops a leading zero byte — raw byte array form", () => {
    expect(normalizeTagId([0x00, 0x01, 0x0a])).toBe("00010A");
  });

  it("never drops a leading zero byte — no-separator string form", () => {
    expect(normalizeTagId("00010a")).toBe("00010A");
  });

  it("preserves ALL leading zero bytes, not just a single one", () => {
    expect(normalizeTagId([0x00, 0x00, 0x00, 0x01])).toBe("00000001");
    expect(normalizeTagId("00:00:00:01")).toBe("00000001");
  });
});

describe("normalizeTagId — idempotent / round-trips with bytesToHex", () => {
  it("normalizing bytesToHex's own output is a no-op", () => {
    const bytes = [0x04, 0xa1, 0x0f, 0x00];
    expect(normalizeTagId(bytesToHex(bytes))).toBe(bytesToHex(bytes));
  });
});

describe("isSameTagIdAnyByteOrder", () => {
  it("matches identical byte arrays", () => {
    expect(isSameTagIdAnyByteOrder([0x04, 0xa1, 0x0f], [0x04, 0xa1, 0x0f])).toBe(true);
  });

  it("matches when one array is the exact reverse of the other", () => {
    expect(isSameTagIdAnyByteOrder([0x04, 0xa1, 0x0f], [0x0f, 0xa1, 0x04])).toBe(true);
  });

  it("does not match two genuinely different tag IDs of the same length", () => {
    expect(isSameTagIdAnyByteOrder([0x04, 0xa1, 0x0f], [0x04, 0xa1, 0x10])).toBe(false);
  });

  it("does not match IDs of different lengths, even if one is a subset", () => {
    expect(isSameTagIdAnyByteOrder([0x04, 0xa1, 0x0f], [0x04, 0xa1])).toBe(false);
  });

  it("does not match two empty arrays (nothing to identify)", () => {
    expect(isSameTagIdAnyByteOrder([], [])).toBe(false);
  });

  it("a palindromic ID trivially matches itself forward and 'reversed'", () => {
    expect(isSameTagIdAnyByteOrder([0x04, 0xa1, 0x04], [0x04, 0xa1, 0x04])).toBe(true);
  });

  it("realistic 7-byte NFC-A UID, reversed byte order", () => {
    const forward = [0x04, 0x8e, 0x7b, 0xe2, 0x20, 0x22, 0x90];
    const reversed = [...forward].reverse();
    expect(isSameTagIdAnyByteOrder(forward, reversed)).toBe(true);
    expect(normalizeTagId(forward)).not.toBe(normalizeTagId(reversed));
  });
});
