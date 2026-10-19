// @vitest-environment jsdom
//
// Inputs: deleting from the Activity details / Workday details section
// headers instead of an Actions column. Covers the row checkboxes and
// select-all (only visible, deletable rows; never Work start or Total break
// time), the Delete (n) header buttons, the section-specific confirmations,
// the single all-or-nothing request per deletion, the refresh afterwards,
// selection clearing on employee/date change, failure handling, editing
// still being available, and the table shape (no Actions column; Speed and
// Start Time in separate cells). Server-side atomicity/locking/retry is in
// server/src/routes/inputs.breakBulkDelete.test.ts and inputs.bulkDelete.test.ts.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { api, ApiError } from "../../lib/api";
import { ActivityRunDto, BreakDto, DailyInputsResponse } from "../../lib/inputsTypes";
import { formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";

const DATE = "2026-10-05";
const PREV_DATE = "2026-10-04";

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-sup", firstName: "Sam", lastName: "Sup", securityRole: "Supervisor" } }),
}));

function run(id: string, activityName: string, start: string, end: string | null, extra: Partial<ActivityRunDto> = {}): ActivityRunDto {
  return {
    id,
    activityId: `act-${activityName}`,
    activityName,
    normalSpeedPerHour: null,
    activityDensitySource: null,
    densityType: null,
    calculatedSpeedPerHour: null,
    isUnresolvedRowCompletion: false,
    rowCompletion: null,
    segmentIds: [id],
    durationSeconds: 600,
    startedAtOriginalTime: null,
    startedAtCorrectedFrom: null,
    endedAtOriginalTime: null,
    endedAtCorrectedFrom: null,
    startedAt: `${DATE}T${start}:00.000Z`,
    currentSegmentStartedAt: `${DATE}T${start}:00.000Z`,
    endedAt: end ? `${DATE}T${end}:00.000Z` : null,
    isOpen: end === null,
    canEdit: end !== null,
    row: null,
    carrier: null,
    autoClosed: false,
    manualEntry: null,
    ...extra,
  } as ActivityRunDto;
}

function brk(id: string, name: string, start: string, end: string | null, isPaid: boolean): BreakDto {
  return {
    id,
    startedAt: `${DATE}T${start}:00.000Z`,
    endedAt: end ? `${DATE}T${end}:00.000Z` : null,
    startedAtOriginalTime: null,
    endedAtOriginalTime: null,
    startedAtCorrectedFrom: null,
    endedAtCorrectedFrom: null,
    durationSeconds: 900,
    name,
    isPaid,
    source: "manual",
    breakProfileItemId: null,
    canEdit: end !== null,
    autoClosed: false,
    manualEntry: null,
  } as BreakDto;
}

interface DayState {
  runs: ActivityRunDto[];
  breaks: BreakDto[];
  totals: DailyInputsResponse["totals"];
  canEdit: boolean;
}

function freshDay(): DayState {
  return {
    runs: [
      run("r-pick", "Picking Peppers", "12:00", "12:30", {
        activityDensitySource: "stems",
        calculatedSpeedPerHour: { value: 1302.4, unit: "stems/hour" },
        startedAtOriginalTime: `${DATE}T11:58:00.000Z`,
      } as Partial<ActivityRunDto>),
      run("r-wind", "Winding & Pruning", "12:30", "13:00"),
      run("r-bags", "Packing Bags", "13:00", "13:30"),
      run("r-open", "Picking Peppers", "14:00", null),
    ],
    breaks: [
      brk("b-coffee", "Coffee", "10:00", "10:15", true),
      brk("b-lunch", "Lunch", "12:00", "12:30", false),
      brk("b-open", "Smoke", "15:00", null, false),
    ],
    totals: { workedSeconds: 7200, breakSeconds: 2700, paidBreakSeconds: 900, unpaidBreakSeconds: 1800 },
    canEdit: true,
  };
}

let day: DayState = freshDay();
let otherDay: DayState = freshDay();
let deleteFailure: string | null = null;

function dailyFor(employeeId: string, date: string): DailyInputsResponse {
  const state = employeeId === "emp-n" && date === DATE ? day : otherDay;
  return {
    employee:
      employeeId === "emp-n"
        ? { id: "emp-n", firstName: "Nattawat", lastName: "N", photoUrl: null }
        : { id: "emp-b", firstName: "Byron", lastName: "E", photoUrl: null },
    date,
    workStartTime: `${date}T08:00:00.000Z`,
    workEndTime: null,
    workStartOriginalTime: null,
    workStartCorrectedFrom: null,
    workStartManualEntry: null,
    runs: state.runs,
    breaks: state.breaks,
    totals: state.totals,
    canEdit: state.canEdit,
  } as unknown as DailyInputsResponse;
}

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
      if (path.startsWith("/api/inputs/employees")) {
        return Promise.resolve({
          employees: [
            { id: "emp-n", firstName: "Nattawat", lastName: "N", photoUrl: null, paidSeconds: 27000 },
            { id: "emp-b", firstName: "Byron", lastName: "E", photoUrl: null, paidSeconds: 20000 },
          ],
        });
      }
      if (path.startsWith("/api/inputs/daily")) {
        const params = new URLSearchParams(path.split("?")[1]);
        return Promise.resolve(dailyFor(params.get("employeeId")!, params.get("date")!));
      }
      if (path.startsWith("/api/row-completions") || path.startsWith("/api/speed-reviews")) {
        return Promise.resolve({ groups: [] });
      }
      if (path === "/api/inputs/activity-runs/bulk-delete" && options?.method === "POST") {
        if (deleteFailure) return Promise.reject(new ApiError(409, deleteFailure));
        const body = JSON.parse(options.body as string) as { runs: string[][] };
        const gone = new Set(body.runs.flat());
        day = { ...day, runs: day.runs.filter((r) => !gone.has(r.id)), totals: { ...day.totals, workedSeconds: 3600 } };
        return Promise.resolve({ ok: true, deleted: body.runs.length });
      }
      if (path === "/api/inputs/breaks/bulk-delete" && options?.method === "POST") {
        if (deleteFailure) return Promise.reject(new ApiError(409, deleteFailure));
        const body = JSON.parse(options.body as string) as { breaks: { id: string }[] };
        const gone = new Set(body.breaks.map((b) => b.id));
        day = {
          ...day,
          breaks: day.breaks.filter((b) => !gone.has(b.id)),
          totals: { ...day.totals, paidBreakSeconds: 0, unpaidBreakSeconds: 600, breakSeconds: 600 },
        };
        return Promise.resolve({ ok: true, deleted: body.breaks.length });
      }
      return Promise.resolve({});
    }),
  };
});

const deleteCalls = () =>
  vi
    .mocked(api)
    .mock.calls.filter(([p, o]) => (p as string).endsWith("delete") && (o as RequestInit | undefined)?.method === "POST")
    .map(([p, o]) => ({ path: p as string, body: JSON.parse((o as RequestInit).body as string) }));
const callsTo = (prefix: string) => vi.mocked(api).mock.calls.filter(([p]) => (p as string).startsWith(prefix)).length;

const activityTable = () => document.querySelector("table.inputs-logs-table") as HTMLElement;
const workdayTable = () => document.querySelector("table.inputs-workday-table") as HTMLElement;
const activityDelete = () =>
  within(document.querySelector(".inputs-section-header-with-status") as HTMLElement).getByRole("button", { name: /^Delete/ });
const breakDelete = () =>
  within(document.querySelector(".inputs-workday-section .inputs-section-header") as HTMLElement).getByRole("button", { name: /^Delete/ });
const runRow = (name: string, nth = 0) => within(activityTable()).getAllByText(name)[nth].closest("tr") as HTMLElement;
const breakRow = (name: string) => within(workdayTable()).getByText(name).closest("tr") as HTMLElement;
const checkboxIn = (row: HTMLElement) => within(row).queryByRole("checkbox");

async function renderPage(employee = "emp-n", date = DATE) {
  render(
    <MemoryRouter initialEntries={[`/inputs?date=${date}&employee=${employee}`]}>
      <InputsPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(activityTable()).not.toBeNull());
}

beforeEach(() => {
  day = freshDay();
  otherDay = freshDay();
  deleteFailure = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("table layout without an Actions column", () => {
  it("neither table has an Actions column, header or cell", async () => {
    await renderPage();
    expect(within(activityTable()).queryByRole("columnheader", { name: /actions/i })).toBeNull();
    expect(within(workdayTable()).queryByRole("columnheader", { name: /actions/i })).toBeNull();
    expect(document.querySelector(".inputs-row-actions, .inputs-th-actions, .inputs-col-actions")).toBeNull();
    // Activity: select + 7 data columns; Workday: select + 5.
    expect(within(activityTable()).getAllByRole("columnheader")).toHaveLength(8);
    expect(activityTable().querySelectorAll("col")).toHaveLength(8);
    expect(within(workdayTable()).getAllByRole("columnheader")).toHaveLength(6);
    for (const row of activityTable().querySelectorAll("tbody tr")) expect(row.querySelectorAll("td")).toHaveLength(8);
  });

  it("Speed and Start Time sit in separate cells; a rounded Start Time shows just the time, no Rounded badge", async () => {
    await renderPage();
    const row = runRow("Picking Peppers");
    const speedCell = row.querySelector("td.inputs-log-speed") as HTMLElement;
    const startCell = row.querySelector("td.inputs-log-starttime") as HTMLElement;
    expect(speedCell).not.toBe(startCell);
    expect(speedCell).toHaveTextContent("1302.4 stems/hour");
    expect(speedCell).not.toHaveTextContent(/AM|PM/);
    expect(startCell).not.toHaveTextContent("stems/hour");
    expect(within(startCell).queryByText("Rounded")).toBeNull();
    expect(document.querySelector(".inputs-rounded-badge")).toBeNull();
    expect(startCell).toHaveTextContent(formatTimeInAppTimezone(`${DATE}T12:00:00.000Z`));
    expect(startCell).not.toHaveTextContent(formatTimeInAppTimezone(`${DATE}T11:58:00.000Z`));
    // Columns line up 1:1 with their headers.
    const headers = within(activityTable()).getAllByRole("columnheader").map((h) => h.textContent);
    const cells = [...row.querySelectorAll("td")];
    expect(cells[headers.indexOf("Speed")]).toBe(speedCell);
    expect(cells[headers.indexOf("Start Time")]).toBe(startCell);
    // Long values keep their full text in a tooltip even if visually truncated.
    expect(within(speedCell).getByTitle(/^1302\.4 stems\/hour/)).toBeInTheDocument();
    expect(within(row).getByTitle("Picking Peppers")).toBeInTheDocument();
  });
});

describe("badges kept after removing Rounded", () => {
  it("Activity details still shows Manually added, In progress and the below-minimum warning, with no Rounded anywhere", async () => {
    day = {
      ...freshDay(),
      runs: [
        run("r-man", "Hand Weeding", "09:00", "09:30", {
          manualEntry: { createdByEmployeeId: "admin", createdByName: "Ada Admin", creationReason: "Forgot phone" },
          endedAtOriginalTime: `${DATE}T09:32:00.000Z`,
          startedAtOriginalTime: `${DATE}T08:58:00.000Z`,
        } as Partial<ActivityRunDto>),
        run("r-short", "Packing Bags", "10:00", "10:01", { isBelowMinimumDuration: true, minimumDurationMinutes: 3 } as Partial<ActivityRunDto>),
        run("r-open", "Picking Peppers", "14:00", null, { startedAtOriginalTime: `${DATE}T13:57:00.000Z` }),
      ],
    };
    await renderPage();
    expect(within(activityTable()).getByText("Manually added")).toBeInTheDocument();
    expect(within(runRow("Picking Peppers")).getAllByText("In progress").length).toBeGreaterThan(0);
    expect(runRow("Packing Bags")).toHaveClass("inputs-log-row-below-minimum");
    expect(within(runRow("Packing Bags")).getByText(/Below 3-minute minimum/)).toBeInTheDocument();
    expect(within(activityTable()).queryByText("Rounded")).toBeNull();
    expect(within(workdayTable()).queryByText("Rounded")).toBeNull();
  });
});

describe("Activity details — header Delete", () => {
  it("Delete is disabled with no selection", async () => {
    await renderPage();
    expect(activityDelete()).toHaveTextContent(/^Delete$/);
    expect(activityDelete()).toBeDisabled();
  });

  it("an in-progress row has no checkbox; finished rows do", async () => {
    await renderPage();
    expect(checkboxIn(runRow("Picking Peppers", 1))).toBeNull();
    expect(checkboxIn(runRow("Picking Peppers", 0))).not.toBeNull();
    expect(checkboxIn(runRow("Packing Bags"))).not.toBeNull();
  });

  it("selecting one row shows Delete (1) and confirms 'Delete 1 activity entry?'", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    expect(activityDelete()).toHaveTextContent("Delete (1)");
    await user.click(activityDelete());
    const dialog = screen.getByRole("dialog", { name: "Delete 1 activity entry?" });
    expect(within(dialog).getByText(/This changes Nattawat N's Inputs record/)).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
    expect(deleteCalls()).toHaveLength(0);
  });

  it("selecting several rows shows the right count and deletes them all in one request", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    await user.click(checkboxIn(runRow("Picking Peppers", 0))!);
    await user.click(checkboxIn(runRow("Winding & Pruning"))!);
    expect(activityDelete()).toHaveTextContent("Delete (3)");
    await user.click(activityDelete());
    const dialog = screen.getByRole("dialog", { name: "Delete 3 activity entries?" });
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: "Delete 3 entries" }));
    });
    await screen.findByText("3 activity entries deleted.");
    expect(deleteCalls()).toEqual([
      { path: "/api/inputs/activity-runs/bulk-delete", body: { employeeId: "emp-n", runs: [["r-pick"], ["r-wind"], ["r-bags"]] } },
    ]);
  });

  it("unchecking a row removes it from the count", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    await user.click(checkboxIn(runRow("Winding & Pruning"))!);
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    expect(activityDelete()).toHaveTextContent("Delete (1)");
  });

  it("select-all picks only the visible deletable rows, and clears them again", async () => {
    const user = userEvent.setup();
    await renderPage();
    const all = within(activityTable()).getByRole("checkbox", { name: "Select all deletable activity entries" });
    await user.click(all);
    expect(activityDelete()).toHaveTextContent("Delete (3)"); // 3 finished, not the in-progress one
    expect(runRow("Picking Peppers", 1)).not.toHaveClass("inputs-log-row-selected");
    expect(all).toBeChecked();
    await user.click(all);
    expect(activityDelete()).toBeDisabled();
  });

  it("refreshes the rows, the Worked total and the sidebar after a successful delete, and clears the selection", async () => {
    const user = userEvent.setup();
    await renderPage();
    const employeesBefore = callsTo("/api/inputs/employees");
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    await user.click(activityDelete());
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete 1 entry" }));
    });
    await screen.findByText("1 activity entry deleted.");
    expect(within(activityTable()).queryByText("Packing Bags")).toBeNull();
    expect(screen.getByText(formatDurationHMS(3600))).toBeInTheDocument();
    expect(callsTo("/api/inputs/employees")).toBeGreaterThan(employeesBefore);
    expect(activityDelete()).toBeDisabled();
    expect(document.querySelectorAll("tr.inputs-log-row-selected")).toHaveLength(0);
  });

  it("a refused delete deletes nothing and says so", async () => {
    deleteFailure = "One or more of the selected activity logs changed since they were loaded — please refresh and try again";
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    await user.click(checkboxIn(runRow("Winding & Pruning"))!);
    await user.click(activityDelete());
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete 2 entries" }));
    });
    const dialog = screen.getByRole("dialog", { name: "Delete 2 activity entries?" });
    expect(await within(dialog).findByText(/^Nothing was deleted\. One or more of the selected activity logs changed/)).toBeInTheDocument();
    expect(within(activityTable()).getByText("Packing Bags")).toBeInTheDocument();
    expect(within(activityTable()).getByText("Winding & Pruning")).toBeInTheDocument();
  });

  it("editing still works: a selected row's Start Time opens the time editor", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(runRow("Packing Bags"));
    await user.click(runRow("Packing Bags").querySelector("td.inputs-log-starttime")!);
    expect(runRow("Packing Bags").querySelectorAll("input[type='time']")).toHaveLength(2);
    expect(within(runRow("Packing Bags")).getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("clicking a checkbox never opens the editor", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    expect(document.querySelector("input[type='time']")).toBeNull();
  });
});

describe("Workday details — header Delete for breaks", () => {
  it("Delete is disabled with no selection", async () => {
    await renderPage();
    expect(breakDelete()).toHaveTextContent(/^Delete$/);
    expect(breakDelete()).toBeDisabled();
  });

  it("Work start, Total break time and an in-progress break are never selectable", async () => {
    await renderPage();
    expect(checkboxIn(breakRow("Work start time"))).toBeNull();
    expect(checkboxIn(breakRow("Total break time"))).toBeNull();
    expect(checkboxIn(breakRow("Smoke"))).toBeNull();
    expect(checkboxIn(breakRow("Coffee"))).not.toBeNull();
  });

  it("deletes one selected break: 'Delete 1 break?'", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(breakRow("Lunch"))!);
    expect(breakDelete()).toHaveTextContent("Delete (1)");
    await user.click(breakDelete());
    const dialog = screen.getByRole("dialog", { name: "Delete 1 break?" });
    expect(within(dialog).getByText(/This changes Nattawat N's Inputs record/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Lunch — .* \(unpaid\)/)).toBeInTheDocument();
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: "Delete 1 break" }));
    });
    await screen.findByText("1 break deleted.");
    expect(deleteCalls()).toEqual([
      {
        path: "/api/inputs/breaks/bulk-delete",
        body: { employeeId: "emp-n", breaks: [{ id: "b-lunch", startedAt: `${DATE}T12:00:00.000Z`, endedAt: `${DATE}T12:30:00.000Z` }] },
      },
    ]);
  });

  it("deletes several selected breaks together, earliest first, and refreshes paid/unpaid totals", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(breakRow("Lunch"))!);
    await user.click(checkboxIn(breakRow("Coffee"))!);
    expect(breakDelete()).toHaveTextContent("Delete (2)");
    await user.click(breakDelete());
    const dialog = screen.getByRole("dialog", { name: "Delete 2 breaks?" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(within(dialog).queryByText(/Work start/)).toBeNull();
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: "Delete 2 breaks" }));
    });
    await screen.findByText("2 breaks deleted.");
    expect(deleteCalls()[0].body.breaks.map((b: { id: string }) => b.id)).toEqual(["b-coffee", "b-lunch"]);
    expect(within(workdayTable()).queryByText("Lunch")).toBeNull();
    const total = breakRow("Total break time");
    expect(total).toHaveTextContent(formatDurationHMS(0));
    expect(total).toHaveTextContent(formatDurationHMS(600));
    expect(breakDelete()).toBeDisabled();
  });

  it("select-all picks only finished breaks — never Work start, Total break time or an open break", async () => {
    const user = userEvent.setup();
    await renderPage();
    const all = within(workdayTable()).getByRole("checkbox", { name: "Select all deletable breaks" });
    await user.click(all);
    expect(breakDelete()).toHaveTextContent("Delete (2)");
    expect(breakRow("Work start time")).not.toHaveClass("inputs-break-row-selected");
    expect(breakRow("Smoke")).not.toHaveClass("inputs-break-row-selected");
    await user.click(breakDelete());
    const dialog = screen.getByRole("dialog", { name: "Delete 2 breaks?" });
    expect(within(dialog).queryByText(/Work start|Smoke|Total/)).toBeNull();
  });

  it("a refused break delete deletes nothing and shows the server's reason", async () => {
    deleteFailure = "The break at 12:00:00 PM–12:30:00 PM changed since it was loaded — please refresh and try again. Nothing was deleted.";
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(breakRow("Lunch"))!);
    await user.click(checkboxIn(breakRow("Coffee"))!);
    await user.click(breakDelete());
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete 2 breaks" }));
    });
    expect(await screen.findByText(deleteFailure)).toBeInTheDocument();
    expect(within(workdayTable()).getByText("Lunch")).toBeInTheDocument();
    expect(within(workdayTable()).getByText("Coffee")).toBeInTheDocument();
  });

  it("editing still works: a selected break's Start Time and the Work start time open their editors", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(breakRow("Lunch"));
    await user.click(breakRow("Lunch").querySelectorAll("td.inputs-time-cell")[0]);
    expect(breakRow("Lunch").querySelector("input[type='time']")).not.toBeNull();
    await user.click(within(breakRow("Lunch")).getByRole("button", { name: "Cancel" }));
    await user.click(breakRow("Work start time").querySelector("td.inputs-time-cell")!);
    expect(breakRow("Work start time").querySelector("input[type='time']")).not.toBeNull();
  });

  it("Work start keeps its existing rules: editable, but there is no way to delete it", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(breakRow("Work start time"));
    expect(breakDelete()).toBeDisabled();
    expect(within(breakRow("Work start time")).queryByRole("button", { name: /delete/i })).toBeNull();
  });
});

describe("selection resets and permissions", () => {
  it("changing the employee clears both selections", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    await user.click(checkboxIn(breakRow("Lunch"))!);
    await user.click(screen.getByRole("button", { name: /Byron E/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Byron E" })).toBeInTheDocument());
    await waitFor(() => expect(activityTable()).not.toBeNull());
    expect(activityDelete()).toBeDisabled();
    expect(breakDelete()).toBeDisabled();
    expect(document.querySelectorAll("input.inputs-select-checkbox:checked")).toHaveLength(0);
  });

  it("changing the date clears both selections", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(checkboxIn(runRow("Packing Bags"))!);
    await user.click(checkboxIn(breakRow("Coffee"))!);
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(activityTable()).not.toBeNull());
    expect(activityDelete()).toBeDisabled();
    expect(breakDelete()).toBeDisabled();
    expect(document.querySelectorAll("input.inputs-select-checkbox:checked")).toHaveLength(0);
    expect(vi.mocked(api).mock.calls.some(([p]) => (p as string).includes(`date=${PREV_DATE}`))).toBe(true);
  });

  it("a viewer who can't edit Inputs gets no checkboxes and no Delete buttons", async () => {
    day = { ...freshDay(), runs: freshDay().runs.map((r) => ({ ...r, canEdit: false })), breaks: freshDay().breaks.map((b) => ({ ...b, canEdit: false })), canEdit: false };
    await renderPage();
    expect(document.querySelectorAll("input.inputs-select-checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  });
});

// Keeps ApiError referenced for the mocked module's shape check.
void ApiError;
