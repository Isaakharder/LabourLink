// Covers the Activity Report speed-unit abbreviation feature: display-only
// shortening of "stems/hour" -> "st/hr" and "plants/hour" -> "pl/hr" in
// pivot cell text, plus the explanatory note text shown alongside it. Never
// touches the underlying speed number or the stored activities.speed_unit
// value — formatSpeedValue itself (the function that produces the raw,
// unabbreviated cell text CSV export still uses) is asserted unchanged.
import { describe, expect, it } from "vitest";
import { abbreviateSpeedCellText, formatSpeedValue, speedUnitAbbreviationNote } from "./reportTypes";

describe("formatSpeedValue — unchanged by the abbreviation feature", () => {
  it("still produces the full, unabbreviated unit and the exact same number formatting", () => {
    expect(formatSpeedValue(51.774465, "stems/hour")).toBe("51.8 stems/hour");
    expect(formatSpeedValue(12.3, "plants/hour")).toBe("12.3 plants/hour");
  });

  it("still returns just the number when there is no unit", () => {
    expect(formatSpeedValue(7, null)).toBe("7.0");
  });
});

describe("abbreviateSpeedCellText", () => {
  it("shortens a formatted stems/hour cell to st/hr", () => {
    expect(abbreviateSpeedCellText("51.8 stems/hour")).toBe("51.8 st/hr");
  });

  it("shortens a formatted plants/hour cell to pl/hr", () => {
    expect(abbreviateSpeedCellText("12.3 plants/hour")).toBe("12.3 pl/hr");
  });

  it("leaves a placeholder / empty cell untouched", () => {
    expect(abbreviateSpeedCellText("—")).toBe("—");
  });

  it("leaves a free-text (non-density-derived) speed unit untouched — nothing to abbreviate it to", () => {
    expect(abbreviateSpeedCellText("4.2 rows/hour")).toBe("4.2 rows/hour");
  });

  it("leaves a completely unrelated metric's cell text (e.g. an H:MM duration) untouched", () => {
    expect(abbreviateSpeedCellText("10:25")).toBe("10:25");
  });
});

describe("speedUnitAbbreviationNote", () => {
  it("returns the exact stems note for stems/hour", () => {
    expect(speedUnitAbbreviationNote("stems/hour")).toBe("Speed shown as st/hr (stems per hour).");
  });

  it("returns the exact plants note for plants/hour", () => {
    expect(speedUnitAbbreviationNote("plants/hour")).toBe("pl/hr means plants per hour.");
  });

  it("returns null for a free-text unit with no defined abbreviation", () => {
    expect(speedUnitAbbreviationNote("rows/hour")).toBeNull();
  });

  it("returns null when there is no unit at all", () => {
    expect(speedUnitAbbreviationNote(null)).toBeNull();
  });
});
