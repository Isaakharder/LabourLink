import { describe, expect, it } from "vitest";
import { buildScanSwitchAnswers, classifyHomeScan, HomeNfcGateContext, isHomeNfcScanActive } from "./nfcActiveScreenScan";

function gate(overrides: Partial<HomeNfcGateContext> = {}): HomeNfcGateContext {
  return {
    foregrounded: true,
    status: "work",
    hasCompetingNfcOwner: false,
    hasRowQuestion: true,
    hasCarrierQuestion: false,
    ...overrides,
  };
}

describe("isHomeNfcScanActive", () => {
  it("is active when foregrounded, working, on a row-based activity, and nothing else owns the reader", () => {
    expect(isHomeNfcScanActive(gate())).toBe(true);
  });

  it("is active on a carrier-only activity (no row question at all)", () => {
    expect(isHomeNfcScanActive(gate({ hasRowQuestion: false, hasCarrierQuestion: true }))).toBe(true);
  });

  it("is active on a dual row+carrier activity like Picking Peppers", () => {
    expect(isHomeNfcScanActive(gate({ hasRowQuestion: true, hasCarrierQuestion: true }))).toBe(true);
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

  it("is inactive on a plain activity with neither a row nor a carrier question", () => {
    expect(isHomeNfcScanActive(gate({ hasRowQuestion: false, hasCarrierQuestion: false }))).toBe(false);
  });

  it("is inactive while a picker sheet, single-question edit, or warning dialog owns/is about to own the reader", () => {
    expect(isHomeNfcScanActive(gate({ hasCompetingNfcOwner: true }))).toBe(false);
  });
});

describe("classifyHomeScan", () => {
  const dualQuestionCtx = { hasRowQuestion: true, hasCarrierQuestion: true, currentRowId: "row-1", currentCarrierId: "bin-1", online: true };

  it("classifies no resolution as unknown", () => {
    expect(classifyHomeScan(null, dualQuestionCtx)).toEqual({ kind: "unknown" });
  });

  it("classifies a resolved row tag as wrong-type when the activity has no row question", () => {
    const result = classifyHomeScan(
      { targetType: "greenhouse_row", targetId: "row-2", label: "Phase A · Row 2" },
      { ...dualQuestionCtx, hasRowQuestion: false }
    );
    expect(result).toEqual({ kind: "wrong-type", targetType: "greenhouse_row" });
  });

  it("classifies a resolved bin tag as wrong-type when the activity has no carrier question", () => {
    const result = classifyHomeScan(
      { targetType: "carrier", targetId: "bin-2", label: "Bin 024" },
      { ...dualQuestionCtx, hasCarrierQuestion: false }
    );
    expect(result).toEqual({ kind: "wrong-type", targetType: "carrier" });
  });

  it("accepts a row tag on a dual row+carrier activity — a genuine row switch", () => {
    const result = classifyHomeScan(
      { targetType: "greenhouse_row", targetId: "row-2", label: "Phase A · Row 2" },
      dualQuestionCtx
    );
    expect(result).toEqual({ kind: "switch", targetType: "greenhouse_row", targetId: "row-2", label: "Phase A · Row 2" });
  });

  it("accepts a bin tag on a dual row+carrier activity — a genuine carrier switch", () => {
    const result = classifyHomeScan({ targetType: "carrier", targetId: "bin-2", label: "Bin 024" }, dualQuestionCtx);
    expect(result).toEqual({ kind: "switch", targetType: "carrier", targetId: "bin-2", label: "Bin 024" });
  });

  it("classifies scanning the row already being worked as a no-op", () => {
    const result = classifyHomeScan(
      { targetType: "greenhouse_row", targetId: "row-1", label: "Phase A · Row 1" },
      dualQuestionCtx
    );
    expect(result).toEqual({ kind: "already-current", targetType: "greenhouse_row" });
  });

  it("classifies scanning the bin already being worked as a no-op (duplicate bin scan suppression)", () => {
    const result = classifyHomeScan({ targetType: "carrier", targetId: "bin-1", label: "Bin 1" }, dualQuestionCtx);
    expect(result).toEqual({ kind: "already-current", targetType: "carrier" });
  });

  it("classifies a genuine row switch as offline when there's no connectivity", () => {
    const result = classifyHomeScan(
      { targetType: "greenhouse_row", targetId: "row-2", label: "Phase A · Row 2" },
      { ...dualQuestionCtx, online: false }
    );
    expect(result).toEqual({ kind: "offline", targetType: "greenhouse_row" });
  });

  it("classifies a genuine bin switch as offline when there's no connectivity", () => {
    const result = classifyHomeScan(
      { targetType: "carrier", targetId: "bin-2", label: "Bin 024" },
      { ...dualQuestionCtx, online: false }
    );
    expect(result).toEqual({ kind: "offline", targetType: "carrier" });
  });

  it("treats a null current row (no row question answered yet) as distinct from any scanned row", () => {
    const result = classifyHomeScan(
      { targetType: "greenhouse_row", targetId: "row-2", label: "Phase A · Row 2" },
      { ...dualQuestionCtx, currentRowId: null }
    );
    expect(result).toEqual({ kind: "switch", targetType: "greenhouse_row", targetId: "row-2", label: "Phase A · Row 2" });
  });

  it("treats a null current carrier (no carrier question answered yet) as distinct from any scanned bin", () => {
    const result = classifyHomeScan(
      { targetType: "carrier", targetId: "bin-2", label: "Bin 024" },
      { ...dualQuestionCtx, currentCarrierId: null }
    );
    expect(result).toEqual({ kind: "switch", targetType: "carrier", targetId: "bin-2", label: "Bin 024" });
  });
});

describe("buildScanSwitchAnswers", () => {
  const rowSwitch = { kind: "switch" as const, targetType: "greenhouse_row" as const, targetId: "row-2", label: "Phase A · Row 2" };
  const carrierSwitch = { kind: "switch" as const, targetType: "carrier" as const, targetId: "bin-2", label: "Bin 024" };

  it("a row scan on a dual-question activity carries the current carrier over unchanged", () => {
    const answers = buildScanSwitchAnswers(rowSwitch, {
      rowQuestionId: "q-row",
      carrierQuestionId: "q-carrier",
      currentRowId: "row-1",
      currentCarrierId: "bin-1",
    });
    expect(answers).toEqual({
      "q-row": { questionId: "q-row", questionType: "greenhouse_row", greenhouseRowId: "row-2" },
      "q-carrier": { questionId: "q-carrier", questionType: "carrier", carrierId: "bin-1" },
    });
  });

  it("a carrier scan on a dual-question activity carries the current row over unchanged", () => {
    const answers = buildScanSwitchAnswers(carrierSwitch, {
      rowQuestionId: "q-row",
      carrierQuestionId: "q-carrier",
      currentRowId: "row-1",
      currentCarrierId: "bin-1",
    });
    expect(answers).toEqual({
      "q-row": { questionId: "q-row", questionType: "greenhouse_row", greenhouseRowId: "row-1" },
      "q-carrier": { questionId: "q-carrier", questionType: "carrier", carrierId: "bin-2" },
    });
  });

  it("omits a question entirely when it has never been answered yet (no current value to carry over)", () => {
    const answers = buildScanSwitchAnswers(rowSwitch, {
      rowQuestionId: "q-row",
      carrierQuestionId: "q-carrier",
      currentRowId: "row-1",
      currentCarrierId: null,
    });
    expect(answers).toEqual({
      "q-row": { questionId: "q-row", questionType: "greenhouse_row", greenhouseRowId: "row-2" },
    });
  });

  it("a row-only activity's carrier scan never touches a nonexistent carrier question", () => {
    const answers = buildScanSwitchAnswers(carrierSwitch, {
      rowQuestionId: "q-row",
      carrierQuestionId: null,
      currentRowId: "row-1",
      currentCarrierId: null,
    });
    expect(answers).toEqual({
      "q-row": { questionId: "q-row", questionType: "greenhouse_row", greenhouseRowId: "row-1" },
    });
  });
});
