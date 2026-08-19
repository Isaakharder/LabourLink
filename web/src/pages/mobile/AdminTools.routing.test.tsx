// @vitest-environment jsdom
//
// Covers the client-side half of the Employees/Messages access control (the
// server-side half — requireDeviceRole rejecting a direct API call — is
// covered by server/src/routes/mobileEmployees.test.ts and
// mobileMessages.test.ts's "unauthorized role" checks) plus the "full-
// screen route with a Back to Settings link" navigation contract shared by
// every mobile Settings subpage (NfcDiagnosticScreen, RegisterExistingTagScreen,
// WriteNewTagScreen — see SettingsScreen.test.tsx's own back-navigation
// coverage for the sibling ChevronLeft header case). Same React-Testing-
// Library + per-module vi.mock() convention as SettingsScreen.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeesScreen } from "./EmployeesScreen";
import { MessagesScreen } from "./MessagesScreen";

let mockSecurityRole = "Employee";
// Stable function/object references across renders, same as the real
// WorkSessionContext's own useCallback-memoized handleApiError — an inline
// arrow function returned fresh on every useWorkSession() call would give
// EmployeesScreen's load() useCallback (which depends on handleApiError) a
// new identity every render, retriggering its own useEffect and looping
// forever (this crashed the test worker with an OOM before this fix).
const mockHandleApiError = vi.fn(() => false);
vi.mock("../../context/WorkSessionContext", () => ({
  useWorkSession: () => ({
    me: { employee: { securityRole: mockSecurityRole } },
    handleApiError: mockHandleApiError,
  }),
}));

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
    api: vi.fn((path: string) => {
      if (path.startsWith("/api/mobile/employees/live")) {
        return Promise.resolve({ weekStart: "2026-08-10", weekEnd: "2026-08-16", generatedAt: new Date().toISOString(), employees: [] });
      }
      if (path.startsWith("/api/mobile/messages/recipients")) {
        return Promise.resolve({ employees: [] });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    }),
  };
});

function renderScreen(path: "/mobile/settings/employees" | "/mobile/settings/messages") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/mobile/settings/employees" element={<EmployeesScreen />} />
        <Route path="/mobile/settings/messages" element={<MessagesScreen />} />
        <Route path="/mobile/settings" element={<div>Settings Screen</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockSecurityRole = "Employee";
});

afterEach(() => {
  cleanup();
});

describe("EmployeesScreen — client-side role gate", () => {
  it("shows an access-denied message and no live data for a general Employee", () => {
    mockSecurityRole = "Employee";
    renderScreen("/mobile/settings/employees");
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
  });

  it("shows the real screen for a Manager (matches GET /api/employees's own role gate)", async () => {
    mockSecurityRole = "Manager";
    renderScreen("/mobile/settings/employees");
    await waitFor(() => expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument());
  });

  it("shows the real screen for an Administrator", async () => {
    mockSecurityRole = "Administrator";
    renderScreen("/mobile/settings/employees");
    await waitFor(() => expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument());
  });

  it("has a Back to Settings link that returns to /mobile/settings", async () => {
    mockSecurityRole = "Administrator";
    const user = userEvent.setup();
    renderScreen("/mobile/settings/employees");
    const back = screen.getByRole("link", { name: /back to settings/i });
    expect(back).toHaveAttribute("href", "/mobile/settings");
    await user.click(back);
    expect(screen.getByText("Settings Screen")).toBeInTheDocument();
  });
});

describe("MessagesScreen — client-side role gate", () => {
  it("shows an access-denied message for a general Employee", () => {
    mockSecurityRole = "Employee";
    renderScreen("/mobile/settings/messages");
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
  });

  it("shows an access-denied message for a Manager — Messages is Administrator-only, unlike Employees", () => {
    mockSecurityRole = "Manager";
    renderScreen("/mobile/settings/messages");
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
  });

  it("shows the real compose screen for an Administrator", async () => {
    mockSecurityRole = "Administrator";
    renderScreen("/mobile/settings/messages");
    await waitFor(() => expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "New message" })).toBeInTheDocument();
  });

  it("has a Back to Settings link that returns to /mobile/settings", async () => {
    mockSecurityRole = "Administrator";
    const user = userEvent.setup();
    renderScreen("/mobile/settings/messages");
    const back = screen.getByRole("link", { name: /back to settings/i });
    expect(back).toHaveAttribute("href", "/mobile/settings");
    await user.click(back);
    expect(screen.getByText("Settings Screen")).toBeInTheDocument();
  });
});
