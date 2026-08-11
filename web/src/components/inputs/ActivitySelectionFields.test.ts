import { beforeAll, describe, expect, it } from "vitest";
import { EmployeeActivityOption } from "../../lib/inputsTypes";

// ActivitySelectionFields.tsx imports ../../lib/api.ts, whose module-level
// resolveApiUrl() reads `window.location` under Vite's dev mode (which
// vitest's default test mode also sets import.meta.env.DEV to) — stub just
// enough of `window` before the module is ever imported, same pattern
// api.test.ts and device.test.ts already use for the same reason.
let buildActivityAnswers: typeof import("./ActivitySelectionFields").buildActivityAnswers;
let isActivitySelectionComplete: typeof import("./ActivitySelectionFields").isActivitySelectionComplete;

beforeAll(async () => {
  (globalThis as { window?: unknown }).window ??= { location: { protocol: "http:", hostname: "localhost" } };
  const mod = await import("./ActivitySelectionFields");
  buildActivityAnswers = mod.buildActivityAnswers;
  isActivitySelectionComplete = mod.isActivitySelectionComplete;
});

const plainActivity: EmployeeActivityOption = {
  id: "activity-plain",
  name: "Plain Activity",
  normalSpeed: null,
  speedUnit: null,
  questions: [],
};

const rowRequiredActivity: EmployeeActivityOption = {
  id: "activity-row",
  name: "Row Activity",
  normalSpeed: null,
  speedUnit: null,
  questions: [{ id: "q-row", questionType: "greenhouse_row", label: "Which row?", isRequired: true }],
};

const carrierOptionalActivity: EmployeeActivityOption = {
  id: "activity-carrier",
  name: "Carrier Activity",
  normalSpeed: null,
  speedUnit: null,
  questions: [{ id: "q-carrier", questionType: "carrier", label: "Which carrier?", isRequired: false }],
};

const bothRequiredActivity: EmployeeActivityOption = {
  id: "activity-both",
  name: "Row + Carrier Activity",
  normalSpeed: null,
  speedUnit: null,
  questions: [
    { id: "q-row2", questionType: "greenhouse_row", label: "Which row?", isRequired: true },
    { id: "q-carrier2", questionType: "carrier", label: "Which carrier?", isRequired: true },
  ],
};

describe("isActivitySelectionComplete", () => {
  it("is false with no activity selected", () => {
    expect(isActivitySelectionComplete(undefined, { activityId: "", greenhouseRowId: "", carrierId: "" })).toBe(
      false
    );
  });

  it("is true for an activity with no questions, regardless of row/carrier fields", () => {
    expect(
      isActivitySelectionComplete(plainActivity, { activityId: plainActivity.id, greenhouseRowId: "", carrierId: "" })
    ).toBe(true);
  });

  it("is false when a required row question is unanswered", () => {
    expect(
      isActivitySelectionComplete(rowRequiredActivity, {
        activityId: rowRequiredActivity.id,
        greenhouseRowId: "",
        carrierId: "",
      })
    ).toBe(false);
  });

  it("is true once the required row question is answered", () => {
    expect(
      isActivitySelectionComplete(rowRequiredActivity, {
        activityId: rowRequiredActivity.id,
        greenhouseRowId: "row-1",
        carrierId: "",
      })
    ).toBe(true);
  });

  it("is true for an optional (not required) question left unanswered", () => {
    expect(
      isActivitySelectionComplete(carrierOptionalActivity, {
        activityId: carrierOptionalActivity.id,
        greenhouseRowId: "",
        carrierId: "",
      })
    ).toBe(true);
  });

  it("requires every required question, not just the first, when an activity has more than one", () => {
    const onlyRow = isActivitySelectionComplete(bothRequiredActivity, {
      activityId: bothRequiredActivity.id,
      greenhouseRowId: "row-1",
      carrierId: "",
    });
    const both = isActivitySelectionComplete(bothRequiredActivity, {
      activityId: bothRequiredActivity.id,
      greenhouseRowId: "row-1",
      carrierId: "carrier-1",
    });
    expect(onlyRow).toBe(false);
    expect(both).toBe(true);
  });
});

describe("buildActivityAnswers", () => {
  it("returns an empty array with no activity", () => {
    expect(buildActivityAnswers(undefined, { activityId: "", greenhouseRowId: "", carrierId: "" })).toEqual([]);
  });

  it("returns an empty array for an activity with no questions", () => {
    expect(
      buildActivityAnswers(plainActivity, { activityId: plainActivity.id, greenhouseRowId: "x", carrierId: "y" })
    ).toEqual([]);
  });

  it("builds a greenhouseRowId answer keyed by the activity's own question id", () => {
    expect(
      buildActivityAnswers(rowRequiredActivity, {
        activityId: rowRequiredActivity.id,
        greenhouseRowId: "row-1",
        carrierId: "",
      })
    ).toEqual([{ questionId: "q-row", greenhouseRowId: "row-1" }]);
  });

  it("omits an answer for a question left blank (e.g. a skipped optional one)", () => {
    expect(
      buildActivityAnswers(carrierOptionalActivity, {
        activityId: carrierOptionalActivity.id,
        greenhouseRowId: "",
        carrierId: "",
      })
    ).toEqual([]);
  });

  it("builds both a row and a carrier answer for an activity with both question types", () => {
    expect(
      buildActivityAnswers(bothRequiredActivity, {
        activityId: bothRequiredActivity.id,
        greenhouseRowId: "row-1",
        carrierId: "carrier-1",
      })
    ).toEqual([
      { questionId: "q-row2", greenhouseRowId: "row-1" },
      { questionId: "q-carrier2", carrierId: "carrier-1" },
    ]);
  });
});
