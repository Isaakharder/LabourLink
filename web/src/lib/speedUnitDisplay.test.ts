import { describe, expect, it } from "vitest";
import { graphSpeedUnit } from "./speedUnitDisplay";

describe("graphSpeedUnit", () => {
  it("shows stems/hour as stm/hr on graphs", () => {
    expect(graphSpeedUnit("stems/hour")).toBe("stm/hr");
    expect(graphSpeedUnit(" Stems/Hour ")).toBe("stm/hr");
  });
  it("leaves every other unit as stored", () => {
    expect(graphSpeedUnit("plants/hour")).toBe("plants/hour");
    expect(graphSpeedUnit("trays/hour")).toBe("trays/hour");
    expect(graphSpeedUnit(null)).toBe("");
  });
});
