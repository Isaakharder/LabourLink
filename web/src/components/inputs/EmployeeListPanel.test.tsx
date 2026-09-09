// @vitest-environment jsdom
//
// Tests the employee nav list's per-row paid-hours total (added alongside
// GET /api/inputs/employees' new paidSeconds field) — H:MM formatting, the
// zero-hours case, the loading placeholder, the accessible label, and that
// the name/hours are two separate flex children (so the name's own
// ellipsis truncation can never push the hours element off-screen) rather
// than one combined string. Renders EmployeeListPanel directly with
// fabricated InputsEmployee fixtures, same convention as
// WorkdayDetailsCard.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmployeeListPanel } from "./EmployeeListPanel";
import { InputsEmployee } from "../../lib/inputsTypes";

afterEach(() => {
  cleanup();
});

function makeEmployee(overrides: Partial<InputsEmployee> = {}): InputsEmployee {
  return {
    id: "emp-1",
    firstName: "Ashfar",
    lastName: "Bhuiyan",
    photoUrl: null,
    paidSeconds: 0,
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof EmployeeListPanel>[0]> = {}) {
  return render(
    <EmployeeListPanel
      employees={[makeEmployee()]}
      error={null}
      loading={false}
      selectedId={null}
      onSelect={vi.fn()}
      search=""
      onSearchChange={vi.fn()}
      {...props}
    />
  );
}

describe("EmployeeListPanel — paid hours", () => {
  it("formats a whole-hour total as H:MM with no leading zero on the hour", () => {
    renderPanel({ employees: [makeEmployee({ paidSeconds: 8 * 3600 })] });
    expect(screen.getByText("8:00")).toBeInTheDocument();
  });

  it("formats a partial-hour total correctly", () => {
    renderPanel({ employees: [makeEmployee({ paidSeconds: 7 * 3600 + 45 * 60 })] });
    expect(screen.getByText("7:45")).toBeInTheDocument();
  });

  it("formats a total over 9h59m without losing the double-digit hour", () => {
    renderPanel({ employees: [makeEmployee({ paidSeconds: 10 * 3600 + 25 * 60 })] });
    expect(screen.getByText("10:25")).toBeInTheDocument();
  });

  it("shows 0:00 for an employee with no recorded paid time, not a blank or negative value", () => {
    renderPanel({ employees: [makeEmployee({ paidSeconds: 0 })] });
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });

  it("never renders decimal hours", () => {
    // 8.25h worth of seconds — the decimal-hours convention this feature
    // explicitly rejects would render "8.25"; H:MM must render "8:15".
    renderPanel({ employees: [makeEmployee({ paidSeconds: 8 * 3600 + 15 * 60 })] });
    expect(screen.getByText("8:15")).toBeInTheDocument();
    expect(screen.queryByText("8.25")).not.toBeInTheDocument();
  });

  it("gives the hours value an accessible label spelling out hours/minutes/paid, distinct from the compact visible text", () => {
    renderPanel({ employees: [makeEmployee({ paidSeconds: 8 * 3600 })] });
    expect(screen.getByLabelText("8 hours paid")).toBeInTheDocument();
    expect(screen.getByLabelText("8 hours paid")).toHaveTextContent("8:00");
  });

  it("pluralizes the accessible label correctly for a partial hour and for zero", () => {
    renderPanel({
      employees: [
        makeEmployee({ id: "e1", paidSeconds: 7 * 3600 + 45 * 60 }),
        makeEmployee({ id: "e2", paidSeconds: 0 }),
      ],
    });
    expect(screen.getByLabelText("7 hours 45 minutes paid")).toBeInTheDocument();
    expect(screen.getByLabelText("0 hours paid")).toBeInTheDocument();
  });

  it("shows — with an accessible 'Paid hours unavailable' label when paidSeconds is null, never 0:00", () => {
    renderPanel({ employees: [makeEmployee({ paidSeconds: null })] });
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0:00")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Paid hours unavailable")).toBeInTheDocument();
  });

  it("distinguishes an unavailable total (null) from a genuine zero on separate rows", () => {
    renderPanel({
      employees: [
        makeEmployee({ id: "e1", firstName: "Ashfar", lastName: "Bhuiyan", paidSeconds: null }),
        makeEmployee({ id: "e2", firstName: "Dave", lastName: "Quiring", paidSeconds: 0 }),
      ],
    });
    const unavailableRow = screen.getByRole("button", { name: /Ashfar Bhuiyan/ });
    const zeroRow = screen.getByRole("button", { name: /Dave Quiring/ });
    expect(within(unavailableRow).getByText("—")).toBeInTheDocument();
    expect(within(unavailableRow).getByLabelText("Paid hours unavailable")).toBeInTheDocument();
    expect(within(zeroRow).getByText("0:00")).toBeInTheDocument();
    expect(within(zeroRow).getByLabelText("0 hours paid")).toBeInTheDocument();
  });

  it("prefers the loading placeholder over the unavailable dash when both would otherwise apply", () => {
    renderPanel({ employees: [makeEmployee({ paidSeconds: null })], loading: true });
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Paid hours loading")).toBeInTheDocument();
  });

  it("shows a placeholder instead of a (possibly stale) number while a fresh total is loading, without shifting the name", () => {
    renderPanel({ employees: [makeEmployee({ paidSeconds: 8 * 3600 })], loading: true });
    // The real value must not render at all while loading — showing the
    // previous date's number here would be exactly the staleness this
    // guards against.
    expect(screen.queryByText("8:00")).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: /Ashfar Bhuiyan/ });
    expect(within(row).getByLabelText("Paid hours loading")).toBeInTheDocument();
  });

  it("keeps the employee name and the paid-hours value as two separate elements, not one combined string", () => {
    renderPanel({
      employees: [
        makeEmployee({
          firstName: "Byron Estuardo Ana",
          lastName: "Escobar",
          paidSeconds: 7 * 3600 + 30 * 60,
        }),
      ],
    });
    const row = screen.getByRole("button", { name: /Byron Estuardo Ana Escobar/ });
    const name = within(row).getByText("Byron Estuardo Ana", { exact: false });
    const hours = within(row).getByText("7:30");
    // Two distinct elements — the long name's own ellipsis/truncation
    // styling can never eat into or push out the hours element, since it
    // isn't part of the same text node.
    expect(name).not.toBe(hours);
    expect(name.className).toContain("inputs-employee-name");
    expect(hours.className).toContain("inputs-employee-hours");
  });

  it("keeps the existing selected-row class untouched by the new hours element", () => {
    const employees = [makeEmployee({ id: "emp-1" }), makeEmployee({ id: "emp-2", firstName: "Dave", lastName: "Quiring" })];
    renderPanel({ employees, selectedId: "emp-2" });
    expect(screen.getByRole("button", { name: /Ashfar Bhuiyan/ }).className).not.toContain("inputs-employee-item-selected");
    expect(screen.getByRole("button", { name: /Dave Quiring/ }).className).toContain("inputs-employee-item-selected");
  });
});
