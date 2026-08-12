import { describe, expect, it } from "vitest";
import { classifyHomeRowScan, HomeNfcGateContext, isHomeNfcScanActive } from "./nfcActiveScreenScan";

function gate(overrides: Partial<HomeNfcGateContext> = {}): HomeNfcGateContext {
  return {
    foregrounded: true,
    status: "work",
    hasCompetingNfcOwner: false,
    isRowBasedActivity: true,
    ...overrides,
  };
}

describe("isHomeNfcScanActive", () => {
  it("is active when foregrounded, working, on a row-based activity, and nothing else owns the reader", () => {
    expect(isHomeNfcScanActive(gate())).toBe(true);
  });

  it("is inactive when backgrounded", () => {
    expect(isHomeNfcScanActive(gate({ foregrounded: false }))).toBe(false);
  });

  it("is inactive when idle", () => {
    expect(isHomeNfcScanActive(gate({ status: "idle" }))).toBe(false);
  });

  it("is inactive on a break", () => {
    expect(isHomeNfcScanActive(gate({ status: "break" }))).toBe(false);
  });

  it("is inactive on a non-row-based (carrier-only or plain) activity", () => {
    expect(isHomeNfcScanActive(gate({ isRowBasedActivity: false }))).toBe(false);
  });

  it("is inactive while a picker sheet, single-question edit, or warning dialog owns/is about to own the reader", () => {
    expect(isHomeNfcScanActive(gate({ hasCompetingNfcOwner: true }))).toBe(false);
  });
});

describe("classifyHomeRowScan", () => {
  it("classifies no resolution as unknown", () => {
    expect(classifyHomeRowScan(null, { currentRowId: "row-1", online: true })).toEqual({ kind: "unknown" });
  });

  it("classifies a resolved bin tag as wrong-type, never touching the row", () => {
    const result = classifyHomeRowScan(
      { targetType: "carrier", targetId: "bin-1" },
      { currentRowId: "row-1", online: true }
    );
    expect(result).toEqual({ kind: "wrong-type" });
  });

  it("classifies scanning the row already being worked as a no-op", () => {
    const result = classifyHomeRowScan(
      { targetType: "greenhouse_row", targetId: "row-1" },
      { currentRowId: "row-1", online: true }
    );
    expect(result).toEqual({ kind: "already-current-row" });
  });

  it("classifies a genuine different-row switch as offline when there's no connectivity", () => {
    const result = classifyHomeRowScan(
      { targetType: "greenhouse_row", targetId: "row-2" },
      { currentRowId: "row-1", online: false }
    );
    expect(result).toEqual({ kind: "offline" });
  });

  it("classifies a genuine different-row switch as switch when online", () => {
    const result = classifyHomeRowScan(
      { targetType: "greenhouse_row", targetId: "row-2" },
      { currentRowId: "row-1", online: true }
    );
    expect(result).toEqual({ kind: "switch", rowId: "row-2" });
  });

  it("treats a null current row (no row question answered yet) as distinct from any scanned row", () => {
    const result = classifyHomeRowScan(
      { targetType: "greenhouse_row", targetId: "row-2" },
      { currentRowId: null, online: true }
    );
    expect(result).toEqual({ kind: "switch", rowId: "row-2" });
  });
});
