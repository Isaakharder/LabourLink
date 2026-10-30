import { describe, expect, it } from "vitest";
import { vacationErrors } from "./employeeDateRules";

const base = { startDate: "2026-01-05", workPermitExpiryDate: "2026-12-31", endDifferentDate: "", vacationStartDate: "", vacationEndDate: "" };

describe("vacationErrors (same rules as the server)", () => {
  it.each([
    ["no vacation", {}, {}],
    ["a valid vacation", { vacationStartDate: "2026-07-01", vacationEndDate: "2026-07-14" }, {}],
    ["ending exactly on the permit expiry", { vacationStartDate: "2026-12-24", vacationEndDate: "2026-12-31" }, {}],
    ["only Start", { vacationStartDate: "2026-07-01" }, { vacationEndDate: "Enter both Start Vacation and End Vacation, or leave both empty" }],
    ["only End", { vacationEndDate: "2026-07-01" }, { vacationStartDate: "Enter both Start Vacation and End Vacation, or leave both empty" }],
    ["End before Start", { vacationStartDate: "2026-07-10", vacationEndDate: "2026-07-01" }, { vacationEndDate: "End Vacation can't be before Start Vacation" }],
    ["before the Employment Start Date", { vacationStartDate: "2026-01-04", vacationEndDate: "2026-01-10" }, { vacationStartDate: "Start Vacation can't be before the Employment Start Date" }],
    ["past the permit", { vacationStartDate: "2026-12-30", vacationEndDate: "2027-01-02" }, { vacationEndDate: "End Vacation can't be after the Work Permit Expiry Date (2026-12-31)" }],
    ["past the End Different Date (wins over the permit)", { endDifferentDate: "2026-10-31", vacationStartDate: "2026-10-30", vacationEndDate: "2026-11-02" }, { vacationEndDate: "End Vacation can't be after the End Different Date (2026-10-31)" }],
    ["ongoing employee, far future", { workPermitExpiryDate: "", vacationStartDate: "2031-07-01", vacationEndDate: "2031-07-21" }, {}],
  ])("%s", (_label, change, expected) => {
    expect(vacationErrors({ ...base, ...change })).toEqual(expected);
  });
});
