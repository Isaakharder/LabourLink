// @vitest-environment jsdom
//
// Layout regression tests for the compact Employees page header (see
// EmployeesPage.tsx / index.css's .employees-page-topbar): the old large
// "Employees" heading + subtitle are gone, both tabs sit directly under the
// normal .app-content padding, the signed-in admin name still shows up (now
// on the same compact row as the tabs), and the Directory/Employment
// Timeline tabs both still render their own content underneath it.
// lib/api.ts is mocked so every network call is fully controlled by the
// test — same convention as DashboardPage.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeesPage } from "./EmployeesPage";
import { AuthProvider } from "../../context/AuthContext";
import { Employee } from "../../lib/employeeTypes";
import { EmploymentTimelineEmployee } from "../../lib/employmentPeriodTypes";

let meResponse: { employee: { id: string; firstName: string; lastName: string; securityRole: string; teamRole: string } };
let employeesResponse: { employees: Employee[]; jobGroups: string[] };
let timelineResponse: { employees: EmploymentTimelineEmployee[] };

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    onSessionExpired: vi.fn(() => () => {}),
    api: vi.fn((path: string) => {
      if (path.startsWith("/api/auth/me")) return Promise.resolve(meResponse);
      if (path.startsWith("/api/employees/")) return Promise.resolve({ employee: employeesResponse.employees[0] });
      if (path.startsWith("/api/employees")) return Promise.resolve(employeesResponse);
      if (path.startsWith("/api/devices")) return Promise.resolve({ devices: [] });
      if (path.startsWith("/api/employment-periods")) return Promise.resolve(timelineResponse);
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "emp-1",
    firstName: "Eve",
    lastName: "Employee",
    gender: null,
    dateOfBirth: null,
    email: "eve@example.com",
    phoneNumber: null,
    jobGroup: "Greenhouse",
    startDate: "2024-01-01",
    isActive: true,
    employeeNumber: "1001",
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

function renderEmployees(initialPath = "/employees/directory") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/employees/*" element={<EmployeesPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  meResponse = {
    employee: { id: "admin-1", firstName: "Ada", lastName: "Admin", securityRole: "Administrator", teamRole: "Team Member" },
  };
  employeesResponse = { employees: [makeEmployee()], jobGroups: ["Greenhouse"] };
  timelineResponse = { employees: [] };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EmployeesPage compact layout", () => {
  it("renders no large heading or subtitle above the tabs", async () => {
    renderEmployees();
    await screen.findByRole("link", { name: "Directory" });

    expect(screen.queryByText("Employees")).not.toBeInTheDocument();
    expect(screen.queryByText(/Manage employee profiles, device assignments, and employment history/)).not.toBeInTheDocument();
    expect(document.querySelector(".page-header-title")).not.toBeInTheDocument();
    expect(document.querySelector(".page-header-description")).not.toBeInTheDocument();
    expect(document.querySelector(".page-header")).not.toBeInTheDocument();
  });

  it("keeps the signed-in admin name at the top-right, now on the compact tab row", async () => {
    renderEmployees();
    await screen.findByText("Ada Admin");

    const topbar = document.querySelector(".employees-page-topbar");
    expect(topbar).toBeInTheDocument();
    expect(topbar?.querySelector(".page-header-user")).toHaveTextContent("Ada Admin");
    expect(topbar?.querySelector(".tabs")).toBeInTheDocument();
  });

  it("keeps both tabs accessible and puts the Directory filters/list directly under them", async () => {
    renderEmployees();
    expect(screen.getByRole("link", { name: "Directory" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Employment Timeline" })).toBeInTheDocument();

    await screen.findByText("1 visible");
    expect(screen.getAllByRole("combobox")).toHaveLength(3); // status, nationality, job group
    expect(screen.getByRole("button", { name: "Add employee" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search employees")).toBeInTheDocument();

    // No heading/subtitle sits between the tabs and the page content — the
    // topbar is the immediate previous sibling of the Directory tab's root.
    const directoryRoot = document.querySelector(".employees-page");
    expect(directoryRoot).toBeInTheDocument();
    expect(directoryRoot?.previousElementSibling).toHaveClass("employees-page-topbar");
  });

  it("renders the Employment Timeline tab's controls directly under the tabs, with the same compact topbar", async () => {
    renderEmployees("/employees/employment-timeline");
    expect(await screen.findByRole("link", { name: "Employment Timeline" })).toHaveClass("tab-active");

    expect(screen.getByText("Full timeline")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Graph")).toBeInTheDocument();
    expect(screen.getByText("Export CSV")).toBeInTheDocument();

    const timelineRoot = document.querySelector(".employment-timeline-view");
    expect(timelineRoot).toBeInTheDocument();
    expect(timelineRoot?.previousElementSibling).toHaveClass("employees-page-topbar");
  });

  it("switches between Directory and Employment Timeline via the tabs without losing the compact topbar", async () => {
    const user = userEvent.setup();
    renderEmployees();
    await screen.findByText("1 visible");

    await user.click(screen.getByRole("link", { name: "Employment Timeline" }));
    await screen.findByText("Export CSV");
    expect(document.querySelector(".employees-page-topbar")).toBeInTheDocument();
    expect(document.querySelector(".employees-page")).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Directory" }));
    await screen.findByText("1 visible");
    expect(document.querySelector(".employees-page-topbar")).toBeInTheDocument();
  });
});
