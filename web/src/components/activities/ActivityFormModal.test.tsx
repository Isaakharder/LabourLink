// @vitest-environment jsdom
//
// Reproduces and locks in the fix for the reported "Density source: Stems /
// Speed unit: plants/hour" invalid configuration on the Edit/Add Activity
// form: the Speed unit field must be derived from and locked to Density
// source whenever one is selected (never independently editable), and must
// immediately show the CORRECTED unit — not the stale saved value — when
// opening an activity that was saved with a mismatch before this check
// existed. Same mocking convention as RowCompletionReviewModal.test.tsx.
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { ActivityFormModal } from "./ActivityFormModal";
import { Activity } from "../../lib/activityTypes";

const apiMock = vi.fn();
vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    errors?: Record<string, string>;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "activity-1",
    name: "Winding & Pruning",
    normalSpeed: 500,
    speedUnit: "plants/hour",
    minimumDurationMinutes: 0,
    isActive: true,
    densitySource: null,
    assignedGroupCount: 0,
    updatedAt: "2026-08-17T00:00:00.000Z",
    questions: [],
    ...overrides,
  };
}

describe("ActivityFormModal — density source / speed unit consistency", () => {
  it("locks the Speed unit field to plants/hour once Plants is selected as the density source", async () => {
    render(<ActivityFormModal activity={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByRole("combobox", { name: /density source/i }), "plants");

    const speedUnitInput = screen.getByLabelText(/speed unit/i) as HTMLInputElement;
    expect(speedUnitInput).toHaveValue("plants/hour");
    expect(speedUnitInput).toBeDisabled();
  });

  it("switches the locked Speed unit to stems/hour when Stems is selected instead", async () => {
    render(<ActivityFormModal activity={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByRole("combobox", { name: /density source/i }), "stems");

    expect(screen.getByLabelText(/speed unit/i)).toHaveValue("stems/hour");
  });

  it("opening an activity already saved with a mismatch (Stems + plants/hour) immediately shows the CORRECTED stems/hour, not the stale saved value", () => {
    render(
      <ActivityFormModal
        activity={activity({ densitySource: "stems", speedUnit: "plants/hour" })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const speedUnitInput = screen.getByLabelText(/speed unit/i) as HTMLInputElement;
    expect(speedUnitInput).toHaveValue("stems/hour");
    expect(speedUnitInput).toBeDisabled();
  });

  it("submits the derived stems/hour unit (not the stale plants/hour) when saving an already-mismatched activity untouched", async () => {
    apiMock.mockResolvedValue({ activity: activity() });
    render(
      <ActivityFormModal
        activity={activity({ densitySource: "stems", speedUnit: "plants/hour" })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(apiMock).toHaveBeenCalledTimes(1);
    const [, options] = apiMock.mock.calls[0];
    const body = JSON.parse((options as { body: string }).body);
    expect(body.speedUnit).toBe("stems/hour");
    expect(body.densitySource).toBe("stems");
  });

  it("restores free-text editing of Speed unit when Density source is cleared back to None", async () => {
    render(
      <ActivityFormModal activity={activity({ densitySource: "plants", speedUnit: "plants/hour" })} onClose={vi.fn()} onSaved={vi.fn()} />
    );
    const user = userEvent.setup();

    await user.selectOptions(screen.getByRole("combobox", { name: /density source/i }), "");

    const speedUnitInput = screen.getByLabelText(/speed unit/i) as HTMLInputElement;
    expect(speedUnitInput).not.toBeDisabled();
    await user.clear(speedUnitInput);
    await user.type(speedUnitInput, "kg/hour");
    expect(speedUnitInput).toHaveValue("kg/hour");
  });
});
