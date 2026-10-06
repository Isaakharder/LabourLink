// @vitest-environment jsdom
//
// Employee Group dropdown on Add/Edit Employee: lists the groups from
// Employees > Employee Groups, defaults to Ungrouped, saves with the profile,
// and never silently changes an employee's current group.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmployeeFormModal } from "./EmployeeFormModal";
import { Employee } from "../../lib/employeeTypes";

const sent: { method: string; path: string; body: any }[] = [];

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
      if (path.startsWith("/api/activity-groups")) return Promise.resolve({ activityGroups: [] });
      if (path.startsWith("/api/break-profiles")) return Promise.resolve({ breakProfiles: [] });
      if (path === "/api/employee-groups") {
        return Promise.resolve({
          groups: [
            { id: "g-pick", name: "Pickers", employeeCount: 3, activeEmployeeCount: 3 },
            { id: "g-prune", name: "Pruners", employeeCount: 1, activeEmployeeCount: 1 },
          ],
          ungrouped: { employeeCount: 5, activeEmployeeCount: 5 },
        });
      }
      if (path.startsWith("/api/employees") && (options?.method === "POST" || options?.method === "PATCH")) {
        sent.push({ method: options.method, path, body: JSON.parse(options.body as string) });
        return Promise.resolve({ employee: { id: "emp-1", activityGroups: [], firstName: "Antonio", lastName: "Miss", device: null } });
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

const groupSelect = () => screen.getByLabelText("Employee Group") as HTMLSelectElement;

function existing(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "emp-1",
    firstName: "Antonio",
    lastName: "Miss",
    gender: "Male",
    dateOfBirth: null,
    email: null,
    phoneNumber: null,
    jobGroup: null,
    startDate: "2026-08-10",
    isActive: true,
    employeeNumber: null,
    nationality: "Mexican",
    preferredLanguage: "Spanish",
    photoUrl: null,
    securityRoleId: 1,
    securityRole: "Employee",
    teamRoleId: 1,
    teamRole: "Team Member",
    device: null,
    activityGroups: [],
    breakProfileId: null,
    breakProfile: null,
    employeeGroup: null,
    workPermitExpiryDate: null,
    workPermitNotifyLeadMonths: null,
    workPermitNotifyLeadDays: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("EmployeeFormModal — Employee Group", () => {
  it("defaults to Ungrouped and lists the groups", async () => {
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(groupSelect().options).toHaveLength(3));
    expect([...groupSelect().options].map((o) => o.text)).toEqual(["Ungrouped", "Pickers", "Pruners"]);
    expect(groupSelect().value).toBe("");
  });

  it("Add Employee saves the chosen group with the profile", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    await user.type(screen.getByLabelText(/First name/), "Jordan");
    await user.type(screen.getByLabelText(/Last name/), "Doe");
    await user.type(screen.getByLabelText(/Start date/), "2026-01-01");
    await user.selectOptions(screen.getByLabelText(/Nationality/), "Canadian");
    await waitFor(() => expect(groupSelect().options).toHaveLength(3));
    await user.selectOptions(groupSelect(), "g-prune");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "POST", path: "/api/employees", body: { employeeGroupId: "g-prune" } });
  });

  it("Edit Employee preselects the current group, and Ungrouped sends null", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={existing({ employeeGroup: { id: "g-pick", name: "Pickers" } })} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(groupSelect().options).toHaveLength(3));
    expect(groupSelect().value).toBe("g-pick");
    await user.selectOptions(groupSelect(), "");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PATCH", path: "/api/employees/emp-1", body: { employeeGroupId: null } });
  });

  it("keeps an employee's current group selectable even if it's missing from the list", async () => {
    render(<EmployeeFormModal employee={existing({ employeeGroup: { id: "g-old", name: "Night Shift" } })} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(groupSelect().options).toHaveLength(4));
    expect(groupSelect().value).toBe("g-old");
    expect([...groupSelect().options].map((o) => o.text)).toContain("Night Shift");
  });
});
