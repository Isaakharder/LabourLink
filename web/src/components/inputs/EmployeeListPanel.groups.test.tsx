// @vitest-environment jsdom
//
// Inputs sidebar grouped by Employee Group: headings with counts, groups
// alphabetical, Ungrouped last, employees alphabetical within each group,
// groups with no listed employee hidden, and the selected-row highlight
// following the employee when their group changes.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmployeeListPanel, groupEmployees } from "./EmployeeListPanel";
import { InputsEmployee } from "../../lib/inputsTypes";

afterEach(() => cleanup());

const pickers = { id: "g-pick", name: "Pickers" };
const crew = { id: "g-crew", name: "beans crew" }; // lower-case on purpose: sort is case-insensitive

function emp(id: string, firstName: string, lastName: string, employeeGroup: InputsEmployee["employeeGroup"], paidSeconds = 27900): InputsEmployee {
  return { id, firstName, lastName, photoUrl: null, paidSeconds, employeeGroup };
}

const EMPLOYEES = [
  emp("e-1", "Larry", "Banguigui", pickers),
  emp("e-2", "Antonio", "Miss", null),
  emp("e-3", "Khen", "Lagto", pickers),
  emp("e-4", "Felimar", "Realin", crew, 27000),
  emp("e-5", "Byron", "Ana", null),
];

function renderPanel(employees: InputsEmployee[], selectedId: string | null = null) {
  return render(
    <EmployeeListPanel
      employees={employees}
      error={null}
      loading={false}
      selectedId={selectedId}
      onSelect={vi.fn()}
      search=""
      onSearchChange={vi.fn()}
    />
  );
}

const headings = () => screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);

describe("EmployeeListPanel — Employee Group headings", () => {
  it("groups alphabetically (case-insensitive) with Ungrouped last, each with its count", () => {
    renderPanel(EMPLOYEES);
    expect(headings()).toEqual(["beans crew1", "Pickers2", "Ungrouped2"]);
  });

  it("lists employees alphabetically within each group", () => {
    renderPanel(EMPLOYEES);
    const pickersSection = screen.getByRole("region", { name: "Pickers (2)" });
    expect(within(pickersSection).getAllByRole("button").map((b) => b.querySelector(".inputs-employee-name")?.textContent)).toEqual([
      "Khen Lagto",
      "Larry Banguigui",
    ]);
    const ungrouped = screen.getByRole("region", { name: "Ungrouped (2)" });
    expect(within(ungrouped).getAllByRole("button").map((b) => b.querySelector(".inputs-employee-name")?.textContent)).toEqual([
      "Antonio Miss",
      "Byron Ana",
    ]);
  });

  it("keeps each row's paid hours", () => {
    renderPanel(EMPLOYEES);
    const row = within(screen.getByRole("region", { name: "beans crew (1)" })).getByRole("button");
    expect(row).toHaveTextContent("Felimar Realin");
    expect(row).toHaveTextContent("7:30");
  });

  it("hides groups with no employee in the current (filtered) list, and counts only what's listed", () => {
    // What a search for "la" returns from the server.
    renderPanel([EMPLOYEES[0], EMPLOYEES[2]]);
    expect(headings()).toEqual(["Pickers2"]);
    expect(screen.queryByRole("region", { name: /Ungrouped/ })).not.toBeInTheDocument();
  });

  it("keeps the selected employee highlighted when their group changes on refresh", () => {
    const { rerender } = renderPanel(EMPLOYEES, "e-2");
    expect(within(screen.getByRole("region", { name: "Ungrouped (2)" })).getByRole("button", { name: /Antonio Miss/ })).toHaveClass(
      "inputs-employee-item-selected"
    );
    const moved = EMPLOYEES.map((e) => (e.id === "e-2" ? { ...e, employeeGroup: pickers } : e));
    rerender(
      <EmployeeListPanel employees={moved} error={null} loading={false} selectedId="e-2" onSelect={vi.fn()} search="" onSearchChange={vi.fn()} />
    );
    const row = within(screen.getByRole("region", { name: "Pickers (3)" })).getByRole("button", { name: /Antonio Miss/ });
    expect(row).toHaveClass("inputs-employee-item-selected");
    expect(document.querySelectorAll(".inputs-employee-item-selected")).toHaveLength(1);
  });

  it("treats a response without group info as Ungrouped", () => {
    const sections = groupEmployees([{ id: "x", firstName: "A", lastName: "B", photoUrl: null, paidSeconds: 0 }]);
    expect(sections.map((s) => [s.name, s.employees.length])).toEqual([["Ungrouped", 1]]);
  });

  it("keeps two same-named groups apart (different ids)", () => {
    const sections = groupEmployees([
      emp("a", "A", "A", { id: "g1", name: "Night" }),
      emp("b", "B", "B", { id: "g2", name: "Night" }),
    ]);
    expect(sections).toHaveLength(2);
  });
});
