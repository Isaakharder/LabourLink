import { describe, expect, it } from "vitest";
import { detectReassignment } from "./reassignment";

describe("detectReassignment", () => {
  it("is false on a device's first-ever pairing (nothing cached yet)", () => {
    expect(detectReassignment(null, "employee-1")).toBe(false);
  });

  it("is false when the same employee's data just refreshed", () => {
    expect(detectReassignment("employee-1", "employee-1")).toBe(false);
  });

  it("is true when a different employee comes back from the server", () => {
    expect(detectReassignment("employee-1", "employee-2")).toBe(true);
  });
});
