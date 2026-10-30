// @vitest-environment jsdom
//
// Add/Edit Employee → Jobs: every active Job listed alphabetically with its
// own checkbox; one, many, all or zero selected (zero = no Jobs); search
// with Select/Clear all visible affecting only the filtered Jobs; the
// "N Jobs selected" count; inactive Jobs still assigned shown read-only and
// never sent; the selection saved in the same request as the employee; a
// server rejection shown on the Jobs section; no Activity Group calls.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeeFormModal } from "./EmployeeFormModal";
import { Employee } from "../../lib/employeeTypes";

const sent: { method: string; path: string; body: any }[] = [];
const calledPaths: string[] = [];
let activeJobs: { id: string; name: string }[] = [];
let saveError: { status: number; errors: Record<string, string> } | null = null;

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    errors?: Record<string, string>;
    constructor(status: number, message: string, errors?: Record<string, string>) {
      super(message);
      this.status = status;
      this.errors = errors;
    }
  }
  return {
    ApiError,
    api: vi.fn((path: string, options?: RequestInit) => {
      calledPaths.push(path);
      if (path === "/api/activities?status=active") return Promise.resolve({ activities: activeJobs });
      if (path.startsWith("/api/break-profiles")) return Promise.resolve({ breakProfiles: [] });
      if (path === "/api/employee-groups") return Promise.resolve({ groups: [], ungrouped: { employeeCount: 0, activeEmployeeCount: 0 } });
      if (path.startsWith("/api/employees") && (options?.method === "POST" || options?.method === "PATCH")) {
        sent.push({ method: options.method, path, body: JSON.parse(options.body as string) });
        if (saveError) return Promise.reject(new ApiError(saveError.status, "Validation failed", saveError.errors));
        return Promise.resolve({ employee: { id: "emp-1", assignedActivities: [], firstName: "A", lastName: "B", device: null } });
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

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
    assignedActivities: [],
    breakProfileId: null,
    breakProfile: null,
    employeeGroup: null,
    workPermitExpiryDate: null,
    workPermitNotifyLeadMonths: null,
    workPermitNotifyLeadDays: null,
    employmentEndDate: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const jobsGroup = () => screen.getByRole("group", { name: "Available Jobs" });
const jobBox = (name: string) => within(jobsGroup()).getByRole("checkbox", { name });
const shownJobs = () => within(jobsGroup()).queryAllByRole("checkbox").map((c) => c.closest("label")!.textContent);
const count = () => screen.getByText(/Jobs? selected/).textContent;
async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(sent).toHaveLength(1));
  return sent[0];
}

beforeEach(() => {
  activeJobs = [
    { id: "j-wind", name: "Winding & Pruning" },
    { id: "j-gen", name: "General" },
    { id: "j-pack", name: "Packing Bags" },
    { id: "j-pick", name: "Picking Peppers" },
    { id: "j-lower", name: "Plant Lowering" },
  ];
  saveError = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sent.length = 0;
  calledPaths.length = 0;
});

describe("Employee form — Jobs", () => {
  it("lists every active Job alphabetically, each with its own checkbox, and never calls Activity Groups", async () => {
    render(<EmployeeFormModal employee={existing()} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(shownJobs()).toHaveLength(5));
    expect(shownJobs()).toEqual(["General", "Packing Bags", "Picking Peppers", "Plant Lowering", "Winding & Pruning"]);
    expect(screen.queryByText(/Activity Groups/)).not.toBeInTheDocument();
    expect(calledPaths.some((p) => p.includes("activity-groups"))).toBe(false);
    expect(count()).toBe("No Jobs selected");
  });

  it("preselects the employee's Jobs and saves exactly one, many, or all in the employee's own request", async () => {
    const user = userEvent.setup();
    render(
      <EmployeeFormModal
        employee={existing({ assignedActivities: [{ id: "j-gen", name: "General", isActive: true }, { id: "j-pick", name: "Picking Peppers", isActive: true }] })}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    await waitFor(() => expect(shownJobs()).toHaveLength(5));
    expect(jobBox("General")).toBeChecked();
    expect(jobBox("Picking Peppers")).toBeChecked();
    expect(jobBox("Plant Lowering")).not.toBeChecked();
    expect(count()).toBe("2 Jobs selected");

    await user.click(jobBox("Winding & Pruning"));
    expect(count()).toBe("3 Jobs selected");
    const req = await save(user);
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/api/employees/emp-1");
    expect([...req.body.activityIds].sort()).toEqual(["j-gen", "j-pick", "j-wind"]);
    expect(req.body.firstName).toBe("Antonio");
  });

  it("one Job: '1 Job selected', and only that id is sent", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={existing()} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(shownJobs()).toHaveLength(5));
    await user.click(jobBox("Plant Lowering"));
    expect(count()).toBe("1 Job selected");
    expect((await save(user)).body.activityIds).toEqual(["j-lower"]);
  });

  it("all Jobs via Select all visible", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={existing()} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(shownJobs()).toHaveLength(5));
    await user.click(screen.getByRole("button", { name: "Select all visible" }));
    expect(count()).toBe("5 Jobs selected");
    expect(screen.getByRole("button", { name: "Select all visible" })).toBeDisabled();
    expect([...(await save(user)).body.activityIds].sort()).toEqual(["j-gen", "j-lower", "j-pack", "j-pick", "j-wind"]);
  });

  it("zero Jobs is saved as an empty list (no Jobs, never all Jobs)", async () => {
    const user = userEvent.setup();
    render(
      <EmployeeFormModal employee={existing({ assignedActivities: [{ id: "j-gen", name: "General", isActive: true }] })} onClose={() => {}} onSaved={() => {}} />
    );
    await waitFor(() => expect(shownJobs()).toHaveLength(5));
    await user.click(screen.getByRole("button", { name: "Clear all visible" }));
    expect(count()).toBe("No Jobs selected");
    expect(screen.getByRole("button", { name: "Clear all visible" })).toBeDisabled();
    expect((await save(user)).body.activityIds).toEqual([]);
  });

  it("search filters the list, and Select/Clear all visible affect only the filtered Jobs", async () => {
    const user = userEvent.setup();
    render(
      <EmployeeFormModal employee={existing({ assignedActivities: [{ id: "j-gen", name: "General", isActive: true }] })} onClose={() => {}} onSaved={() => {}} />
    );
    await waitFor(() => expect(shownJobs()).toHaveLength(5));
    await user.type(screen.getByRole("searchbox", { name: "Search Jobs" }), "p");
    // "p" matches Packing, Picking, Plant, Pruning — not General.
    expect(shownJobs()).toEqual(["Packing Bags", "Picking Peppers", "Plant Lowering", "Winding & Pruning"]);
    expect(count()).toBe("1 Job selected · showing 4 of 5");

    await user.click(screen.getByRole("button", { name: "Select all visible" }));
    expect(count()).toBe("5 Jobs selected · showing 4 of 5");

    await user.clear(screen.getByRole("searchbox", { name: "Search Jobs" }));
    await user.type(screen.getByRole("searchbox", { name: "Search Jobs" }), "pi");
    expect(shownJobs()).toEqual(["Picking Peppers"]);
    await user.click(screen.getByRole("button", { name: "Clear all visible" }));
    expect(count()).toBe("4 Jobs selected · showing 1 of 5");

    await user.clear(screen.getByRole("searchbox", { name: "Search Jobs" }));
    await user.type(screen.getByRole("searchbox", { name: "Search Jobs" }), "zzz");
    expect(screen.getByText("No Jobs match “zzz”.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select all visible" })).toBeDisabled();

    await user.clear(screen.getByRole("searchbox", { name: "Search Jobs" }));
    expect(jobBox("General")).toBeChecked();
    expect(jobBox("Picking Peppers")).not.toBeChecked();
    expect([...(await save(user)).body.activityIds].sort()).toEqual(["j-gen", "j-lower", "j-pack", "j-wind"]);
  });

  it("shows inactive Jobs still assigned read-only, separately, and never sends them", async () => {
    const user = userEvent.setup();
    render(
      <EmployeeFormModal
        employee={existing({
          assignedActivities: [
            { id: "j-gen", name: "General", isActive: true },
            { id: "j-old", name: "Old Harvest", isActive: false },
          ],
        })}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    await waitFor(() => expect(shownJobs()).toHaveLength(5));
    expect(shownJobs()).not.toContain("Old Harvest");
    expect(screen.getByText("Inactive Jobs still assigned")).toBeInTheDocument();
    expect(screen.getByText(/Old Harvest/).closest("li")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Old Harvest/ })).not.toBeInTheDocument();
    expect(screen.getByText(/gets the Job back if it is reactivated/)).toBeInTheDocument();
    expect(count()).toBe("1 Job selected");
    expect((await save(user)).body.activityIds).toEqual(["j-gen"]);
  });

  it("a Job deactivated since the employee was loaded moves to the read-only list and isn't sent", async () => {
    const user = userEvent.setup();
    activeJobs = activeJobs.filter((j) => j.id !== "j-pick");
    render(
      <EmployeeFormModal
        employee={existing({ assignedActivities: [{ id: "j-gen", name: "General", isActive: true }, { id: "j-pick", name: "Picking Peppers", isActive: true }] })}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    await waitFor(() => expect(shownJobs()).toHaveLength(4));
    expect(screen.getByText("Inactive Jobs still assigned")).toBeInTheDocument();
    expect(count()).toBe("1 Job selected");
    expect((await save(user)).body.activityIds).toEqual(["j-gen"]);
  });

  it("Add Employee sends the chosen Jobs with the new employee", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    await user.type(screen.getByLabelText(/First name/), "Jordan");
    await user.type(screen.getByLabelText(/Last name/), "Doe");
    await user.type(screen.getByLabelText(/^Employment Start Date/), "2026-01-01");
    await user.selectOptions(screen.getByLabelText(/Nationality/), "Canadian");
    await waitFor(() => expect(shownJobs()).toHaveLength(5));
    await user.click(jobBox("General"));
    await user.click(jobBox("Picking Peppers"));
    const req = await save(user);
    expect(req.method).toBe("POST");
    expect([...req.body.activityIds].sort()).toEqual(["j-gen", "j-pick"]);
    expect(calledPaths.filter((p) => p.startsWith("/api/employees"))).toEqual(["/api/employees"]);
  });

  it("shows the server's Jobs error on the Jobs section", async () => {
    const user = userEvent.setup();
    saveError = { status: 400, errors: { activityIds: "Picking Peppers is inactive and can't be assigned. Refresh and try again." } };
    render(<EmployeeFormModal employee={existing()} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(shownJobs()).toHaveLength(5));
    await user.click(jobBox("Picking Peppers"));
    await save(user);
    expect(await screen.findByText("Picking Peppers is inactive and can't be assigned. Refresh and try again.")).toBeInTheDocument();
  });
});
