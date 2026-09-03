// @vitest-environment jsdom
//
// Role-gating: a Manager viewer (readOnly=true, since only Administrators
// may mutate employment periods per the server's own requireRole gate on
// employmentPeriods.ts) sees the same layout with no editable inputs and no
// destructive actions — the client-side mirror of that server restriction,
// not the only enforcement of it.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmploymentPeriodModal } from "./EmploymentPeriodModal";
import { EmploymentPeriod } from "../../lib/employmentPeriodTypes";

vi.mock("../../lib/api", () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

afterEach(() => {
  cleanup();
});

const period: EmploymentPeriod = {
  id: "period-1",
  employeeId: "emp-1",
  startDate: "2026-01-01",
  expectedFinishDate: "2026-06-01",
  actualFinishDate: null,
  employmentType: "Seasonal",
  workGroup: "Greenhouse",
  workGroupOtherDescription: null,
  notes: null,
  statuses: ["current"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("EmploymentPeriodModal — role gating", () => {
  it("readOnly (Manager viewer): every field is disabled, and there is no Save or Delete button", () => {
    render(<EmploymentPeriodModal employeeId="emp-1" employeeName="Alice Smith" period={period} readOnly onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByLabelText(/start date/i)).toBeDisabled();
    expect(screen.getByLabelText(/expected finish date/i)).toBeDisabled();
    expect(screen.getByLabelText(/actual finish date/i)).toBeDisabled();
    expect(screen.getByLabelText(/employment type/i)).toBeDisabled();
    expect(screen.getByLabelText(/work group/i)).toBeDisabled();
    expect(screen.getByLabelText(/notes/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete period/i })).not.toBeInTheDocument();
  });

  it("editable (Administrator): fields are enabled and Save/Delete are present", () => {
    render(<EmploymentPeriodModal employeeId="emp-1" employeeName="Alice Smith" period={period} readOnly={false} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete period/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/notes/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/start date/i)).not.toBeDisabled();
  });

  it("read-only viewers never see the deactivation-safety note or delete confirmation UI meant for editors", () => {
    render(<EmploymentPeriodModal employeeId="emp-1" employeeName="Alice Smith" period={null} readOnly onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByText(/does not deactivate this employee/i)).not.toBeInTheDocument();
  });
});
