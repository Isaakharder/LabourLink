import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCalendarDate as formatDate } from "./calendarDateDisplay";

// The Directory showed date-only fields a day early west of UTC (it parsed
// "YYYY-MM-DD" as midnight UTC). Pin the zone to the organization's.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Toronto";
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe("formatCalendarDate (Employees Directory dates)", () => {
  it.each([
    ["2021-04-15", 15, 3, 2021],
    ["2026-12-31", 31, 11, 2026],
    ["2026-03-08", 8, 2, 2026], // spring-forward day
    ["2026-11-01", 1, 10, 2026], // fall-back day
    ["2028-02-29", 29, 1, 2028], // leap day
  ])("shows %s as that same calendar day", (value, day, monthIndex, year) => {
    const expected = new Date(year, monthIndex, day).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    expect(formatDate(value)).toBe(expected);
  });

  it("still formats full timestamps and placeholders", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("not a date");
  });
});
