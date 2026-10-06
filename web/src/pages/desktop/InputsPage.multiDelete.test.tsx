// @vitest-environment jsdom
//
// Inputs activity table: Ctrl/Cmd+click multi-select and deleting several
// activity logs at once — one all-or-nothing request carrying each log's
// own segment ids (server behaviour: server/src/routes/inputs.bulkDelete.test.ts).
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { api } from "../../lib/api";
import { ActivityRunDto, DailyInputsResponse } from "../../lib/inputsTypes";

const DATE = "2026-10-05";
let bulkDeleteFailure: string | null = null;

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-sup", firstName: "Sam", lastName: "Sup", securityRole: "Supervisor" } }),
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
    api: vi.fn((path: string, options?: RequestInit) => {
      if (path.startsWith("/api/inputs/employees")) {
        return Promise.resolve({ employees: [{ id: "emp-n", firstName: "Nattawat", lastName: "N", photoUrl: null, paidSeconds: 27000 }] });
      }
      if (path.startsWith("/api/inputs/daily")) return Promise.resolve(daily());
      if (path === "/api/inputs/activity-runs/bulk-delete" && options?.method === "POST") {
        return bulkDeleteFailure ? Promise.reject(new ApiError(409, bulkDeleteFailure)) : Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function run(id: string, activityName: string, start: string, end: string | null, rowLabel: string | null): ActivityRunDto {
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
    row: rowLabel ? ({ id: `row-${id}`, label: rowLabel } as ActivityRunDto["row"]) : null,
    carrier: null,
    autoClosed: false,
    manualEntry: null,
  } as ActivityRunDto;
}

// Listed out of chronological order on purpose: deletion must still go
// earliest first.
const RUNS = [
  run("r-pick-619", "Picking Peppers", "12:00", "12:18", "Phase 2 · Row 619"),
  run("r-bags-1", "Packing Bags", "12:18", "12:19", null),
  run("r-pick-617", "Picking Peppers", "12:19", "12:50", "Phase 2 · Row 617"),
  run("r-bags-2", "Packing Bags", "12:50", "12:51", null),
  run("r-open", "Packing Bags", "13:00", null, null),
];

function daily(): DailyInputsResponse {
  return {
    employee: { id: "emp-n", firstName: "Nattawat", lastName: "N", photoUrl: null },
    date: DATE,
    workStartTime: null,
    workEndTime: null,
    workStartOriginalTime: null,
    workStartCorrectedFrom: null,
    workStartManualEntry: null,
    runs: RUNS,
    breaks: [],
    totals: { workedSeconds: 3600, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 },
    canEdit: true,
  } as unknown as DailyInputsResponse;
}

const rowOf = (activityText: string, nth = 0) => screen.getAllByText(activityText)[nth].closest("tr") as HTMLElement;
// Every delete request sent: path + parsed body.
const deleteCalls = () =>
  vi
    .mocked(api)
    .mock.calls.filter(([p, o]) => (p as string).endsWith("delete") && (o as RequestInit | undefined)?.method === "POST")
    .map(([p, o]) => ({ path: p as string, body: JSON.parse((o as RequestInit).body as string) }));

async function renderPage() {
  render(
    <MemoryRouter initialEntries={[`/inputs?date=${DATE}&employee=emp-n`]}>
      <InputsPage />
    </MemoryRouter>
  );
  await screen.findAllByText("Picking Peppers");
}

beforeEach(() => {
  bulkDeleteFailure = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Inputs multi-row select and delete", () => {
  it("Ctrl+click adds rows to the selection; a plain click goes back to one row", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(rowOf("Picking Peppers", 0));
    await user.keyboard("{Control>}");
    await user.click(rowOf("Packing Bags", 0));
    await user.click(rowOf("Picking Peppers", 1));
    await user.keyboard("{/Control}");
    const selected = document.querySelectorAll("tr.inputs-log-row-selected");
    expect(selected).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Delete 3 selected" }).length).toBe(3);

    await user.click(rowOf("Packing Bags", 1));
    expect(document.querySelectorAll("tr.inputs-log-row-selected")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("Ctrl+click on a selected row removes it; Cmd works like Ctrl", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(rowOf("Picking Peppers", 0));
    await user.keyboard("{Meta>}");
    await user.click(rowOf("Picking Peppers", 1));
    await user.click(rowOf("Picking Peppers", 0));
    await user.keyboard("{/Meta}");
    const selected = [...document.querySelectorAll("tr.inputs-log-row-selected")];
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(rowOf("Picking Peppers", 1));
  });

  it("Ctrl+click on a time cell selects instead of opening the time editor", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(rowOf("Picking Peppers", 0));
    const startCell = within(rowOf("Picking Peppers", 0)).getAllByRole("cell").find((c) => c.className.includes("inputs-log-starttime"))!;
    await user.keyboard("{Control>}");
    await user.click(within(rowOf("Packing Bags", 0)).getAllByRole("cell").find((c) => c.className.includes("inputs-log-starttime"))!);
    await user.click(startCell);
    await user.keyboard("{/Control}");
    expect(document.querySelector("input[type='time']")).toBeNull();
  });

  it("deletes every selected log in one request — exact segments, earliest first — after one confirmation listing them", async () => {
    const user = userEvent.setup();
    await renderPage();
    // Selected out of order, and including the in-progress row.
    await user.click(rowOf("Picking Peppers", 1));
    await user.keyboard("{Control>}");
    await user.click(rowOf("Packing Bags", 0));
    await user.click(rowOf("Picking Peppers", 0));
    await user.click(rowOf("Packing Bags", 2));
    await user.keyboard("{/Control}");

    await user.click(screen.getAllByRole("button", { name: "Delete 3 selected" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Delete 3 activity logs?" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
    expect(within(dialog).getByText(/1 selected in-progress activity is not included/)).toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(0); // nothing deleted before confirming

    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: "Delete 3 Logs" }));
    });
    await waitFor(() => expect(screen.getByText("3 activity logs deleted.")).toBeInTheDocument());
    expect(deleteCalls()).toEqual([
      { path: "/api/inputs/activity-runs/bulk-delete", body: { runs: [["r-pick-619"], ["r-bags-1"], ["r-pick-617"]] } },
    ]);
  });

  it("if anything changed, nothing is deleted and the dialog says so", async () => {
    bulkDeleteFailure = "One or more of the selected activity logs changed since they were loaded — please refresh and try again";
    const user = userEvent.setup();
    await renderPage();
    await user.click(rowOf("Picking Peppers", 0));
    await user.keyboard("{Control>}");
    await user.click(rowOf("Packing Bags", 0));
    await user.keyboard("{/Control}");
    await user.click(screen.getAllByRole("button", { name: "Delete 2 selected" })[0]);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete 2 Logs" }));
    });
    const dialog = screen.getByRole("dialog", { name: "Delete 2 activity logs?" });
    expect(await within(dialog).findByText(/Nothing was deleted\. One or more of the selected activity logs changed/)).toBeInTheDocument();
    expect(screen.queryByText(/activity logs deleted\./)).not.toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(1);
  });
});
