// @vitest-environment jsdom
//
// The employee-list row (.employees-list-item) is a fixed 4-column grid —
// avatar | name (flexible, truncates) | status badge (fixed-width column) |
// chevron — specifically so the status badge and chevron line up column to
// column regardless of how long an employee's name is (see index.css's
// .employees-list-item comment). jsdom has no layout engine, so this can't
// assert pixel positions (same limitation noted in DashboardPage.test.tsx's
// grid test) — instead it asserts the structural contract that produces
// that alignment: every row renders exactly the same 4 elements, in the
// same order, whether the name is short or absurdly long, for both active
// and inactive employees.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryTab } from "./DirectoryTab";
import { AuthProvider } from "../../../context/AuthContext";
import { Employee } from "../../../lib/employeeTypes";

let meResponse: { employee: { id: string; firstName: string; lastName: string; securityRole: string; teamRole: string } };
let employeesResponse: { employees: Employee[]; jobGroups: string[] };

vi.mock("../../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    api: vi.fn((path: string) => {
      if (path.startsWith("/api/auth/me")) return Promise.resolve(meResponse);
      if (path.startsWith("/api/devices")) return Promise.resolve({ devices: [] });
      if (path.startsWith("/api/employees/")) {
        const id = path.split("/api/employees/")[1];
        const employee = employeesResponse.employees.find((e) => e.id === id) ?? null;
        return employee ? Promise.resolve({ employee }) : Promise.reject(new ApiError(404, "Not found"));
      }
      if (path.startsWith("/api/employees")) return Promise.resolve(employeesResponse);
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "emp-1",
    firstName: "Al",
    lastName: "Wu",
    gender: null,
    dateOfBirth: null,
    email: null,
    phoneNumber: null,
    jobGroup: "Greenhouse",
    startDate: "2024-01-01",
    isActive: true,
    employeeNumber: null,
    nationality: "Canadian",
    preferredLanguage: null,
    photoUrl: null,
    securityRoleId: 1,
    securityRole: "Employee",
    teamRoleId: 1,
    teamRole: "Team Member",
    device: null,
    activityGroups: [],
    breakProfileId: null,
    breakProfile: null,
    workPermitExpiryDate: null,
    workPermitNotifyLeadMonths: null,
    workPermitNotifyLeadDays: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderDirectory() {
  return render(
    <MemoryRouter initialEntries={["/employees/directory"]}>
      <AuthProvider>
        <DirectoryTab />
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  meResponse = {
    employee: { id: "admin-1", firstName: "Ada", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DirectoryTab employee-list row alignment", () => {
  it("gives every row the same 4-column structure (avatar, name, status badge, chevron) for a short name (active) and a very long name (inactive)", async () => {
    employeesResponse = {
      employees: [
        makeEmployee({ id: "emp-short", firstName: "Al", lastName: "Wu", isActive: true }),
        makeEmployee({
          id: "emp-long",
          firstName: "Maximilliana",
          lastName: "Wolfeschlegelsteinhausenbergerdorff",
          isActive: false,
        }),
      ],
      jobGroups: ["Greenhouse"],
    };

    await act(async () => {
      renderDirectory();
    });
    await screen.findByText("2 visible");

    const rows = document.querySelectorAll(".employees-list-item");
    expect(rows).toHaveLength(2);

    rows.forEach((row) => {
      const children = Array.from(row.children);
      expect(children).toHaveLength(4);

      const [avatar, name, status, chevron] = children;
      expect(avatar).toHaveClass("avatar");
      expect(name).toHaveClass("employees-list-item-name");
      expect(status).toHaveClass("status-pill", "employees-list-item-status");
      expect(chevron).toHaveClass("employees-list-item-chevron");

      // The badge is always the row's 3rd grid child and the chevron always
      // the 4th, regardless of the name's length — this fixed column
      // position (not the name's rendered width) is what keeps every row's
      // badge/chevron aligned with the others.
      expect(row.children[2]).toBe(status);
      expect(row.children[3]).toBe(chevron);
    });

    const [shortNameRow, longNameRow] = Array.from(rows);
    expect(shortNameRow.querySelector(".employees-list-item-name")).toHaveTextContent("Al Wu");
    expect(shortNameRow.querySelector(".employees-list-item-status")).toHaveTextContent("Active");
    expect(shortNameRow.querySelector(".employees-list-item-status")).toHaveClass("status-active");

    expect(longNameRow.querySelector(".employees-list-item-name")).toHaveTextContent(
      "Maximilliana Wolfeschlegelsteinhausenbergerdorff"
    );
    expect(longNameRow.querySelector(".employees-list-item-status")).toHaveTextContent("Inactive");
    expect(longNameRow.querySelector(".employees-list-item-status")).toHaveClass("status-inactive");
  });

  it("keeps the same row structure when filtering to an all-inactive list", async () => {
    employeesResponse = {
      employees: [
        makeEmployee({ id: "emp-a", firstName: "Bo", lastName: "Ng", isActive: false }),
        makeEmployee({
          id: "emp-b",
          firstName: "Christopheranna",
          lastName: "Featherstonehaugh-Smythe",
          isActive: false,
        }),
      ],
      jobGroups: ["Greenhouse"],
    };

    await act(async () => {
      renderDirectory();
    });
    await screen.findByText("2 visible");

    const rows = document.querySelectorAll(".employees-list-item");
    rows.forEach((row) => {
      expect(row.children).toHaveLength(4);
      expect(row.children[2]).toHaveClass("employees-list-item-status", "status-inactive");
      expect(row.children[2]).toHaveTextContent("Inactive");
      expect(row.children[3]).toHaveClass("employees-list-item-chevron");
    });
  });
});
