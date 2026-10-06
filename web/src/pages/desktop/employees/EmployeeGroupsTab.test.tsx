// @vitest-environment jsdom
//
// Employees > Employee Groups tab: list with counts (and the Ungrouped
// row), create with blank/duplicate validation, rename, delete with a
// confirmation explaining employees become Ungrouped, and the read-only
// Manager view. Server behaviour: server/src/routes/employeeGroups.test.ts.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeeGroupsTab } from "./EmployeeGroupsTab";
import { api } from "../../../lib/api";

let role = "Administrator";
let groups: { id: string; name: string; employeeCount: number; activeEmployeeCount: number }[] = [];

vi.mock("../../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "me", firstName: "Isaak", lastName: "Harder", securityRole: role } }),
}));

vi.mock("../../../lib/api", () => {
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
      const method = options?.method ?? "GET";
      const body = options?.body ? JSON.parse(options.body as string) : null;
      if (path === "/api/employee-groups" && method === "GET") {
        return Promise.resolve({ groups, ungrouped: { employeeCount: 7, activeEmployeeCount: 6 } });
      }
      if (path === "/api/employee-groups" && method === "POST") {
        if (groups.some((g) => g.name.toLowerCase() === body.name.toLowerCase())) {
          return Promise.reject(new ApiError(409, "Conflict", { name: "An employee group with this name already exists" }));
        }
        groups = [...groups, { id: `g-${body.name}`, name: body.name, employeeCount: 0, activeEmployeeCount: 0 }];
        return Promise.resolve({ group: groups[groups.length - 1] });
      }
      const m = path.match(/^\/api\/employee-groups\/(.+)$/);
      if (m && method === "PATCH") {
        groups = groups.map((g) => (g.id === m[1] ? { ...g, name: body.name } : g));
        return Promise.resolve({ group: groups.find((g) => g.id === m[1]) });
      }
      if (m && method === "DELETE") {
        const g = groups.find((x) => x.id === m[1])!;
        groups = groups.filter((x) => x.id !== m[1]);
        return Promise.resolve({ ok: true, ungroupedEmployees: g.employeeCount });
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${method} ${path}`));
    }),
  };
});

const calls = (method: string) => vi.mocked(api).mock.calls.filter(([, o]) => ((o as RequestInit | undefined)?.method ?? "GET") === method);

beforeEach(() => {
  role = "Administrator";
  groups = [
    { id: "g-pick", name: "Pickers", employeeCount: 4, activeEmployeeCount: 3 },
    { id: "g-prune", name: "Pruners", employeeCount: 2, activeEmployeeCount: 2 },
  ];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EmployeeGroupsTab", () => {
  it("lists every group with its employee count, plus Ungrouped", async () => {
    render(<EmployeeGroupsTab />);
    const pickers = (await screen.findByText("Pickers")).closest("tr")!;
    expect(pickers).toHaveTextContent("3 employees · 1 inactive");
    expect(screen.getByText("Pruners").closest("tr")).toHaveTextContent("2 employees");
    expect(screen.getByText("Ungrouped").closest("tr")).toHaveTextContent("6 employees · 1 inactive");
  });

  it("refuses a blank name without sending anything", async () => {
    const user = userEvent.setup();
    render(<EmployeeGroupsTab />);
    await screen.findByText("Pickers");
    await user.type(screen.getByLabelText("New group"), "   ");
    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Group name is required");
    expect(calls("POST")).toHaveLength(0);
  });

  it("creates a group and shows it", async () => {
    const user = userEvent.setup();
    render(<EmployeeGroupsTab />);
    await screen.findByText("Pickers");
    await user.type(screen.getByLabelText("New group"), "Night Shift");
    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(await screen.findByText("Night Shift")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent('Group "Night Shift" created.');
    expect((screen.getByLabelText("New group") as HTMLInputElement).value).toBe("");
  });

  it("shows the server's duplicate-name error", async () => {
    const user = userEvent.setup();
    render(<EmployeeGroupsTab />);
    await screen.findByText("Pickers");
    await user.type(screen.getByLabelText("New group"), "pickers");
    await user.click(screen.getByRole("button", { name: "Add group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An employee group with this name already exists");
  });

  it("renames a group", async () => {
    const user = userEvent.setup();
    render(<EmployeeGroupsTab />);
    const row = (await screen.findByText("Pruners")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New name for Pruners");
    await user.clear(input);
    await user.type(input, "Pruning Crew{Enter}");
    expect(await screen.findByText("Pruning Crew")).toBeInTheDocument();
    expect(calls("PATCH")[0][0]).toBe("/api/employee-groups/g-prune");
  });

  it("deletes only after confirming, explaining its employees become Ungrouped", async () => {
    const user = userEvent.setup();
    render(<EmployeeGroupsTab />);
    const row = (await screen.findByText("Pickers")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent('Delete "Pickers"?');
    expect(dialog).toHaveTextContent("The 4 employees in this group will become Ungrouped. No employees are deleted");
    expect(calls("DELETE")).toHaveLength(0);
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: "Delete group" }));
    });
    await waitFor(() => expect(screen.queryByText("Pickers")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent('Group "Pickers" deleted. 4 employees are now Ungrouped.');
  });

  it("is read-only for a Manager", async () => {
    role = "Manager";
    render(<EmployeeGroupsTab />);
    await screen.findByText("Pickers");
    expect(screen.queryByLabelText("New group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});
