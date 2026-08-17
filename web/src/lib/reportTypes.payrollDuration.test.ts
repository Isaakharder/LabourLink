// Reproduces and locks in the fix for the reported "Payroll Report shows
// 10.42 instead of 10:25" bug: decimal-hours formatting (secondsToDecimalHours,
// e.g. "10.42") read as "10 hours 42 minutes" to anyone not fluent in
// decimal-hour notation, when the real duration was 10 hours 25 minutes.
// formatPayrollDuration (H:MM) replaces it everywhere in the Payroll Report.
import { describe, expect, it } from "vitest";
import { formatPayrollDuration, payrollPivotCellValue } from "./reportTypes";

describe("formatPayrollDuration", () => {
  it("1) exactly 10:25:00 (37500s) displays as 10:25", () => {
    expect(formatPayrollDuration(10 * 3600 + 25 * 60)).toBe("10:25");
  });

  it("2) never produces a decimal-hour-looking string for any duration", () => {
    const samples = [0, 30, 61, 3661, 37500, 232500];
    for (const s of samples) {
      expect(formatPayrollDuration(s)).not.toMatch(/\./);
    }
  });

  it("3) minutes are always zero-padded to two digits", () => {
    expect(formatPayrollDuration(9 * 3600 + 2 * 60)).toBe("9:02");
    expect(formatPayrollDuration(6 * 3600 + 5 * 60)).toBe("6:05");
  });

  it("4) hours are allowed to exceed 24 for a weekly/grand total, never wrapped", () => {
    expect(formatPayrollDuration(64 * 3600 + 35 * 60)).toBe("64:35");
  });

  it("6) rounds to the nearest whole minute, consistently at the exact half-minute boundary", () => {
    expect(formatPayrollDuration(29)).toBe("<1m"); // rounds to 0 min, but is real positive time
    expect(formatPayrollDuration(30)).toBe("0:01"); // exact half-minute rounds up
    expect(formatPayrollDuration(89)).toBe("0:01"); // 1.483 min -> rounds to 1
    expect(formatPayrollDuration(90)).toBe("0:02"); // exact half-minute rounds up
    expect(formatPayrollDuration(3599)).toBe("1:00"); // 59.98 min -> rounds up to 60 -> carries into the hour
  });

  it("does not silently make a tiny-but-real duration look identical to zero — the '0.01' cells from the bug report", () => {
    // 0.01 decimal hours under the OLD format was ~36 seconds — still a
    // real, positive duration that must never render as literal "0:00".
    expect(formatPayrollDuration(36)).toBe("0:01");
    expect(formatPayrollDuration(1)).toBe("<1m");
    expect(formatPayrollDuration(0)).toBe("0:00"); // genuinely zero is fine to show as 0:00 — distinct from "<1m"
  });

  it("clamps a negative input to zero rather than producing a malformed string", () => {
    expect(formatPayrollDuration(-5)).toBe("0:00");
  });
});

describe("payrollPivotCellValue", () => {
  const source = { workSeconds: 37500, breakSeconds: 1800, unpaidBreakSeconds: 900, paidSeconds: 38400, totalSeconds: 39300 };

  it("formats every payroll duration metric as H:MM from its own seconds field", () => {
    expect(payrollPivotCellValue("workTime", source)).toBe("10:25");
    expect(payrollPivotCellValue("breakTime", source)).toBe("0:30");
    expect(payrollPivotCellValue("unpaidTime", source)).toBe("0:15");
    expect(payrollPivotCellValue("paidTime", source)).toBe("10:40");
    expect(payrollPivotCellValue("totalHours", source)).toBe("10:55");
  });

  it("falls back to an em dash for a metric with no cell value (identity/label fields)", () => {
    expect(payrollPivotCellValue("employee", source)).toBe("—");
  });
});
