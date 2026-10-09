// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesProvider } from "../../context/UnsavedChangesContext";

let role = "Administrator";
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { securityRole: role }, logout: vi.fn() }),
}));

import { Sidebar } from "./Sidebar";

afterEach(() => {
  cleanup();
  role = "Administrator";
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <UnsavedChangesProvider>
        <Sidebar />
      </UnsavedChangesProvider>
    </MemoryRouter>
  );
}

describe("Sidebar Display group", () => {
  it("replaces Greenhouse with Display, open with Setup and Map on a Display page", () => {
    renderAt("/display/setup");
    expect(screen.queryByText("Greenhouse")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Display/ })).toHaveAttribute("aria-expanded", "true");
    // The sidebar also has the top-level Setup page (/setup), so match by address.
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/display/setup", "/display/map", "/setup"]));
  });

  it("starts collapsed elsewhere and expands on click", async () => {
    renderAt("/inputs");
    const toggle = screen.getByRole("button", { name: /Display/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const hrefs = () => screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs()).not.toContain("/display/setup");
    await userEvent.setup().click(toggle);
    expect(screen.getByRole("link", { name: "Map" })).toBeInTheDocument();
  });

  it("is hidden from roles that couldn't open it (same as before)", () => {
    role = "Employee";
    renderAt("/inputs");
    expect(screen.queryByRole("button", { name: /Display/ })).not.toBeInTheDocument();
  });
});
