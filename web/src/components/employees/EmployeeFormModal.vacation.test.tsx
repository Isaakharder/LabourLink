// @vitest-environment jsdom
//
// Start/End Vacation on the Add/Edit Employee form: the same employee
// fields the Employment Timeline editor saves (one record), the same
// validation, and clearing.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmployeeFormModal } from "./EmployeeFormModal";
import { Employee } from "../../lib/employeeTypes";

const sent: { method: string; body: Record<string, unknown> }[] = [];

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
    api: vi.fn((path: string, options?: RequestInit) => {
      if (path.startsWith("/api/activities")) return Promise.resolve({ activities: [] });
      if (path.startsWith("/api/break-profiles")) return Promise.resolve({ breakProfiles: [] });
      if (path === "/api/employee-groups") return Promise.resolve({ groups: [], ungrouped: { employeeCount: 0, activeEmployeeCount: 0 } });
      if (path.startsWith("/api/employees") && (options?.method === "PATCH" || options?.method === "POST")) {
        sent.push({ method: options.method, body: JSON.parse(options.body as string) });
        return Promise.resolve({ employee: { id: "emp-1", assignedActivities: [], firstName: "A", lastName: "B", device: null } });
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sent.length = 0;
});

function existing(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "emp-1",
    firstName: "Antonio",
    lastName: "Miss",
    gender: null,
    dateOfBirth: null,
    email: null,
    phoneNumber: null,
    jobGroup: null,
    startDate: "2026-01-05",
    isActive: true,
    employeeNumber: null,
    nationality: "Mexican",
    preferredLanguage: null,
    photoUrl: null,
    securityRoleId: 1,
    securityRole: "Employee",
    teamRoleId: 1,
    teamRole: "Team Member",
    device: null,
    assignedActivities: [],
    breakProfileId: null,
    breakProfile: null,
    employeeGroup: null,
    workPermitExpiryDate: "2026-12-31",
    workPermitNotifyLeadMonths: 6,
    workPermitNotifyLeadDays: null,
    employmentEndDate: null,
    vacationStartDate: null,
    vacationEndDate: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const start = () => screen.getByLabelText(/^Start Vacation/) as HTMLInputElement;
const end = () => screen.getByLabelText(/^End Vacation/) as HTMLInputElement;

describe("Employee form — vacation", () => {
  it("shows the saved vacation and saves edits on the same employee record", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={existing({ vacationStartDate: "2026-07-01", vacationEndDate: "2026-07-14" })} onClose={() => {}} onSaved={() => {}} />);
    expect(start().value).toBe("2026-07-01");
    expect(end().value).toBe("2026-07-14");
    fireEvent.change(end(), { target: { value: "2026-07-21" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PATCH", body: { vacationStartDate: "2026-07-01", vacationEndDate: "2026-07-21" } });
    expect(sent[0].body.isActive).toBe(true); // unchanged — vacation never deactivates
  });

  it("clearing both dates sends null for both", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={existing({ vacationStartDate: "2026-07-01", vacationEndDate: "2026-07-14" })} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(start(), { target: { value: "" } });
    fireEvent.change(end(), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toMatchObject({ vacationStartDate: null, vacationEndDate: null });
  });

  it.each([
    ["only one date", "2026-07-01", "", "Enter both Start Vacation and End Vacation, or leave both empty"],
    ["End before Start", "2026-07-10", "2026-07-01", "End Vacation can't be before Start Vacation"],
    ["before the Employment Start Date", "2026-01-01", "2026-01-10", "Start Vacation can't be before the Employment Start Date"],
    ["past the Work Permit Expiry Date", "2026-12-28", "2027-01-03", "End Vacation can't be after the Work Permit Expiry Date (2026-12-31)"],
  ])("rejects %s with the same message as the timeline, saving nothing", async (_label, s, e, message) => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={existing()} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(start(), { target: { value: s } });
    fireEvent.change(end(), { target: { value: e } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });
});
