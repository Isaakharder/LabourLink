// @vitest-environment jsdom
//
// Productivity shown (077): a Job can show its row-count speed or
// kilograms/hour from LabourLink Scale. Choosing kg/hour keeps the density
// source, speed unit and row-count normal speed exactly as they were.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  return { ApiError, api: (...args: unknown[]) => apiMock(...args) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const picking: Activity = {
  id: "pick",
  name: "Picking Peppers",
  normalSpeed: 420,
  speedUnit: "stems/hour",
  minimumDurationMinutes: 0,
  isActive: true,
  densitySource: "stems",
  assignedEmployeeCount: 3,
  updatedAt: "2026-11-24T00:00:00.000Z",
  questions: [],
};

const lastPayload = () => JSON.parse(apiMock.mock.calls[apiMock.mock.calls.length - 1][1].body);

describe("Edit Job: productivity shown", () => {
  it("defaults to the row-count speed and sends it unchanged", async () => {
    apiMock.mockResolvedValue({});
    render(<ActivityFormModal activity={picking} onClose={vi.fn()} onSaved={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: /productivity shown/i });
    expect(select).toHaveValue("density");
    expect(screen.getByRole("option", { name: "Stems/hour (row counts)" })).toBeInTheDocument();
    expect(screen.queryByText(/Normal speed \(kg\/hour\)/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(lastPayload()).toMatchObject({ productivityMetric: "density", densitySource: "stems", speedUnit: "stems/hour", normalSpeed: 420 });
  });

  it("kg/hour keeps the row-count settings and saves its own target", async () => {
    apiMock.mockResolvedValue({});
    render(<ActivityFormModal activity={picking} onClose={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: /productivity shown/i }), "scale_kg");
    const kg = screen.getByRole("spinbutton", { name: /normal speed \(kg\/hour\)/i });
    await user.type(kg, "150");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(lastPayload()).toMatchObject({
      productivityMetric: "scale_kg",
      scaleNormalKgPerHour: 150,
      densitySource: "stems",
      speedUnit: "stems/hour",
      normalSpeed: 420,
    });
  });

  it("rejects a kg/hour target of zero", async () => {
    render(<ActivityFormModal activity={{ ...picking, productivityMetric: "scale_kg" }} onClose={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("spinbutton", { name: /normal speed \(kg\/hour\)/i }), "0");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Normal speed must be greater than 0")).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
