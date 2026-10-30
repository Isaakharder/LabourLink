// @vitest-environment jsdom
//
// Inputs: Up/Down arrows move the employee selection through the sidebar as
// listed (groups alphabetical, Ungrouped last, headings skipped), within the
// current search, without wrapping, without touching the date, and never
// while the focused control, an open dialog or an inline edit uses the keys.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { api } from "../../lib/api";
import { ActivityRunDto, DailyInputsResponse } from "../../lib/inputsTypes";
import { renderInputsOn } from "../../lib/testUtils/inputsToday";
import { formatTimeInAppTimezone } from "../../lib/timezone";

const DATE = "2026-10-05";
const PREV_DATE = "2026-10-04";

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-admin", firstName: "Ada", lastName: "Admin", securityRole: "Administrator" } }),
}));

const pickers = { id: "g-pick", name: "Pickers" };
const beans = { id: "g-bean", name: "Bean Crew" };
// Listed order: Bean Crew (Mia, Noor) · Pickers (Khen, Larry) · Ungrouped (Maximiliano…, Zed)
const ROSTER = [
  { id: "emp-khen", firstName: "Khen", lastName: "Lagto", employeeGroup: pickers, paidSeconds: 27900 },
  { id: "emp-larry", firstName: "Larry", lastName: "Banguigui", employeeGroup: pickers, paidSeconds: 26760 },
  { id: "emp-mia", firstName: "Mia", lastName: "Santos", employeeGroup: beans, paidSeconds: 18000 },
  { id: "emp-noor", firstName: "Noor", lastName: "Aziz", employeeGroup: beans, paidSeconds: 18000 },
  { id: "emp-long", firstName: "Maximiliano-Bartholomew", lastName: "Featherstonehaugh-Worthington", employeeGroup: null, paidSeconds: 30600 },
  { id: "emp-zed", firstName: "Zed", lastName: "Quinn", employeeGroup: null, paidSeconds: 3600 },
];
const ORDER = ["emp-mia", "emp-noor", "emp-khen", "emp-larry", "emp-long", "emp-zed"];
const NAME = Object.fromEntries(ROSTER.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

interface DailyCall {
  employeeId: string;
  date: string;
  resolve: () => void;
}
let dailyCalls: DailyCall[] = [];
let holdDaily = false;

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
    api: vi.fn((path: string, options?: RequestInit) => {
      const url = new URL(path, "http://t");
      if (url.pathname === "/api/inputs/employees") {
        const search = (url.searchParams.get("search") ?? "").toLowerCase();
        return Promise.resolve({
          employees: ROSTER.filter((e) => `${e.firstName} ${e.lastName}`.toLowerCase().includes(search)).map((e) => ({ ...e, photoUrl: null })),
        });
      }
      if (url.pathname === "/api/inputs/daily") {
        const employeeId = url.searchParams.get("employeeId")!;
        const date = url.searchParams.get("date")!;
        return new Promise((resolve, reject) => {
          const call = { employeeId, date, resolve: () => resolve(daily(employeeId, date)) };
          dailyCalls.push(call);
          (options?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          if (!holdDaily) call.resolve();
        });
      }
      if (url.pathname === "/api/row-completions/review-groups") {
        return Promise.resolve({ date: url.searchParams.get("date"), groups: [{ id: "g1", employeeId: "emp-larry" }], windowDays: 7 });
      }
      return Promise.resolve({});
    }),
  };
});

function run(id: string, name: string): ActivityRunDto {
  return {
    id,
    activityId: `act-${id}`,
    activityName: name,
    normalSpeedPerHour: null,
    activityDensitySource: null,
    densityType: null,
    calculatedSpeedPerHour: null,
    isUnresolvedRowCompletion: false,
    rowCompletion: null,
    segmentIds: [id],
    durationSeconds: 1800,
    startedAtOriginalTime: null,
    startedAtCorrectedFrom: null,
    endedAtOriginalTime: null,
    endedAtCorrectedFrom: null,
    startedAt: `${DATE}T13:00:00.000Z`,
    currentSegmentStartedAt: `${DATE}T13:00:00.000Z`,
    endedAt: `${DATE}T13:30:00.000Z`,
    isOpen: false,
    canEdit: true,
    row: null,
    carrier: null,
    autoClosed: false,
    manualEntry: null,
  } as ActivityRunDto;
}

function daily(employeeId: string, date: string): DailyInputsResponse {
  return {
    employee: { id: employeeId, firstName: NAME[employeeId].split(" ")[0], lastName: NAME[employeeId].split(" ").slice(1).join(" "), photoUrl: null },
    date,
    workStartTime: null,
    workEndTime: null,
    workStartOriginalTime: null,
    workStartCorrectedFrom: null,
    workStartManualEntry: null,
    runs: [run(`r-${employeeId}`, `Work of ${NAME[employeeId]}`)],
    breaks: [],
    totals: { workedSeconds: 1800, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 },
    canEdit: true,
  } as unknown as DailyInputsResponse;
}

function Probe() {
  const l = useLocation();
  return <div data-testid="location">{l.search}</div>;
}

function renderPage(employee = "emp-khen") {
  return renderInputsOn(DATE, () =>
    render(
      <MemoryRouter initialEntries={[`/inputs?employee=${employee}`]}>
        <InputsPage />
        <Probe />
      </MemoryRouter>
    )
  );
}

const rowOf = (id: string) => document.querySelector(`.inputs-employee-item[data-employee-id="${id}"]`) as HTMLElement;
const selected = () => document.querySelector(".inputs-employee-item-selected")?.getAttribute("data-employee-id");
const press = (key: "ArrowUp" | "ArrowDown", target: Element = document.body, init: KeyboardEventInit = {}) => {
  let event!: KeyboardEvent;
  act(() => {
    event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
  });
  return event;
};
async function ready(employee = "emp-khen") {
  await waitFor(() => expect(rowOf("emp-zed")).not.toBeNull());
  await waitFor(() => expect(selected()).toBe(employee));
  await screen.findByText(`Work of ${NAME[employee]}`);
}
const shownEmployee = () => screen.queryByText(/^Work of /)?.textContent;

let scrollIntoView: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dailyCalls = [];
  holdDaily = false;
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("moving with the arrow keys", () => {
  it("Down and Up step through the listed employees, across group boundaries, skipping headings", async () => {
    renderPage("emp-khen");
    await ready();
    press("ArrowDown");
    await waitFor(() => expect(selected()).toBe("emp-larry"));
    press("ArrowDown"); // Pickers -> Ungrouped
    await waitFor(() => expect(selected()).toBe("emp-long"));
    await screen.findByText(`Work of ${NAME["emp-long"]}`);
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowUp"); // Pickers -> Bean Crew
    await waitFor(() => expect(selected()).toBe("emp-noor"));
    expect(screen.getByTestId("location")).toHaveTextContent("employee=emp-noor");
    await screen.findByText(`Work of ${NAME["emp-noor"]}`);
  });

  it("stops at the first and last employee without wrapping, and keeps the page from scrolling", async () => {
    renderPage("emp-mia");
    await ready("emp-mia");
    const up = press("ArrowUp");
    expect(up.defaultPrevented).toBe(true);
    expect(selected()).toBe("emp-mia");

    for (let i = 0; i < ORDER.length + 3; i++) press("ArrowDown");
    await waitFor(() => expect(selected()).toBe("emp-zed"));
    const down = press("ArrowDown");
    expect(down.defaultPrevented).toBe(true);
    expect(selected()).toBe("emp-zed");
  });

  it("keeps the selected date", async () => {
    const user = userEvent.setup();
    renderPage("emp-khen");
    await ready();
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(dailyCalls.slice(-1)[0]).toMatchObject({ employeeId: "emp-khen", date: PREV_DATE }));
    (document.activeElement as HTMLElement).blur();
    press("ArrowDown");
    await waitFor(() => expect(dailyCalls.slice(-1)[0]).toMatchObject({ employeeId: "emp-larry", date: PREV_DATE }));
    expect(dailyCalls.some((c) => c.employeeId === "emp-larry" && c.date !== PREV_DATE)).toBe(false);
  });

  it("only moves through the employees the current search lists", async () => {
    const user = userEvent.setup();
    renderPage("emp-mia");
    await ready("emp-mia");
    // "an": Mia Santos, Larry Banguigui, Maximiliano… — not Noor, Khen or Zed.
    await user.type(screen.getByPlaceholderText("Search employees"), "an");
    await waitFor(() => expect(rowOf("emp-noor")).toBeNull());
    await waitFor(() => expect(rowOf("emp-larry")).not.toBeNull());
    (document.activeElement as HTMLElement).blur();
    press("ArrowDown");
    await waitFor(() => expect(selected()).toBe("emp-larry")); // skips Noor and Khen
    press("ArrowDown");
    await waitFor(() => expect(selected()).toBe("emp-long"));
    press("ArrowDown");
    expect(selected()).toBe("emp-long"); // last listed: Zed is filtered out
  });

  it("scrolls the newly selected employee into view", async () => {
    renderPage("emp-khen");
    await ready();
    scrollIntoView.mockClear();
    press("ArrowDown");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const last = scrollIntoView.mock.contexts.slice(-1)[0] as HTMLElement;
    expect(last.getAttribute("data-employee-id")).toBe("emp-larry");
    expect(scrollIntoView.mock.calls.slice(-1)[0]?.[0]).toEqual({ block: "nearest" });
  });

  it("focus follows the selection when it was on an employee row", async () => {
    renderPage("emp-khen");
    await ready();
    rowOf("emp-khen").focus();
    press("ArrowDown", rowOf("emp-khen"));
    await waitFor(() => expect(document.activeElement).toBe(rowOf("emp-larry")));
  });

  it("held/rapid presses: an older employee's response never replaces the newest selection", async () => {
    renderPage("emp-mia");
    await ready("emp-mia");
    holdDaily = true;
    const before = dailyCalls.length;
    press("ArrowDown", document.body, { repeat: true });
    press("ArrowDown", document.body, { repeat: true });
    press("ArrowDown", document.body, { repeat: true });
    await waitFor(() => expect(selected()).toBe("emp-larry"));
    const pending = dailyCalls.slice(before);
    expect(pending.slice(-1)[0]?.employeeId).toBe("emp-larry");
    // Answers arrive newest first, then the stale ones.
    await act(async () => {
      for (const c of [...pending].reverse()) c.resolve();
    });
    await waitFor(() => expect(shownEmployee()).toBe(`Work of ${NAME["emp-larry"]}`));
    expect(selected()).toBe("emp-larry");
  });

  it("keeps the blue selected style and the orange review badge", async () => {
    renderPage("emp-khen");
    await ready();
    await waitFor(() => expect(rowOf("emp-larry").querySelector(".inputs-employee-review")).not.toBeNull());
    press("ArrowDown");
    await waitFor(() => expect(selected()).toBe("emp-larry"));
    expect(rowOf("emp-larry")).toHaveClass("inputs-employee-item-selected", "inputs-employee-item-needs-review");
    expect(rowOf("emp-larry").querySelector(".inputs-employee-review")).toHaveTextContent("1");
    expect(rowOf("emp-khen")).not.toHaveClass("inputs-employee-item-selected");
  });
});

describe("arrow keys that belong to something else", () => {
  it("are ignored in the search box, inputs, selects and checkboxes", async () => {
    renderPage("emp-khen");
    await ready();
    const search = screen.getByPlaceholderText("Search employees");
    search.focus();
    expect(press("ArrowDown", search).defaultPrevented).toBe(false);

    const checkbox = within(document.querySelector("table.inputs-logs-table") as HTMLElement).getAllByRole("checkbox")[0];
    checkbox.focus();
    expect(press("ArrowDown", checkbox).defaultPrevented).toBe(false);
    expect(checkbox).not.toBeChecked();

    for (const el of [Object.assign(document.createElement("input"), { type: "number" }), document.createElement("select"), document.createElement("textarea")]) {
      document.body.appendChild(el);
      el.focus();
      expect(press("ArrowUp", el).defaultPrevented).toBe(false);
      el.remove();
    }
    expect(selected()).toBe("emp-khen");
  });

  it("are ignored with a modifier key held", async () => {
    renderPage("emp-khen");
    await ready();
    press("ArrowDown", document.body, { shiftKey: true });
    press("ArrowDown", document.body, { altKey: true });
    press("ArrowDown", document.body, { ctrlKey: true });
    expect(selected()).toBe("emp-khen");
  });

  it("are ignored while the date calendar or a modal is open", async () => {
    const user = userEvent.setup();
    renderPage("emp-khen");
    await ready();
    await user.click(screen.getByRole("button", { name: "Choose Inputs date" }));
    expect(screen.getByRole("dialog", { name: "Choose Inputs date" })).toBeInTheDocument();
    press("ArrowDown");
    expect(selected()).toBe("emp-khen");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Add activity" }));
    await screen.findByRole("dialog");
    press("ArrowDown");
    expect(selected()).toBe("emp-khen");
  });

  it("are ignored during an inline time edit, even with focus moved off the editor", async () => {
    const user = userEvent.setup();
    const { container } = renderPage("emp-khen");
    await ready();
    const endText = formatTimeInAppTimezone(`${DATE}T13:30:00.000Z`);
    await user.click(screen.getByText(endText));
    await user.click(screen.getByText(endText));
    const editor = container.querySelector('.inputs-log-endtime input[type="time"]') as HTMLInputElement;
    expect(editor).not.toBeNull();
    editor.focus();
    expect(press("ArrowUp", editor).defaultPrevented).toBe(false);
    editor.blur();
    press("ArrowDown");
    expect(selected()).toBe("emp-khen");
    expect(container.querySelector('.inputs-log-endtime input[type="time"]')).not.toBeNull();
  });
});
