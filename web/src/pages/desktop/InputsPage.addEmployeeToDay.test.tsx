// @vitest-environment jsdom
//
// Inputs sidebar "Add employee to this day" (+ beside Review all employees):
// role visibility, the Review button and its badge staying intact, the
// picker listing only active employees with no work on the date (and its
// empty state), required row/bin fields, no Reason field, the request sent
// to the shared manual-entry route (POST /api/inputs/activities in its
// addEmployeeToDay mode, with an idempotency key), selecting the employee
// afterwards, and overlap/duplicate/save-time-race handling. The server side
// of the same flow is server/src/routes/inputs.addEmployeeToDay.test.ts.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputsPage } from "./InputsPage";
import { api, ApiError } from "../../lib/api";
import { DailyInputsResponse } from "../../lib/inputsTypes";
import { todayInAppTimezone } from "../../lib/timezone";

const PAST_DATE = "2026-10-05";
let role = "Administrator";
// Employees with work on the date (the sidebar). The picker offers the rest
// of NAMES — the server's "active, no work that day" filter.
let onDay: string[] = [];
// Next POST /activities result: "ok", "duplicate", an ApiError to reject
// with, or "raceLost" (someone else recorded work for them first).
let postResult: "ok" | "duplicate" | "raceLost" | { status: number; message: string } = "ok";

const NAMES: Record<string, [string, string]> = {
  "emp-khen": ["Khen", "Lagto"],
  "emp-larry": ["Larry", "Banguigui"],
  "emp-jhang": ["Jhang", "Cruz"],
  "emp-mia": ["Mia", "Reyes"],
};

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-admin", firstName: "Ada", lastName: "Admin", securityRole: role } }),
}));

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, _errors?: Record<string, string>, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError, api: vi.fn() };
});

function mockApi(path: string, options?: RequestInit): Promise<unknown> {
  if (path.startsWith("/api/inputs/employees")) {
    return Promise.resolve({
      employees: onDay.map((id) => ({
        id,
        firstName: NAMES[id][0],
        lastName: NAMES[id][1],
        photoUrl: null,
        paidSeconds: 3600,
        employeeGroup: null,
      })),
    });
  }
  if (path.startsWith("/api/inputs/employee-options")) {
    return Promise.resolve({
      employees: Object.entries(NAMES)
        .filter(([id]) => !onDay.includes(id))
        .map(([id, [firstName, lastName]]) => ({
          id,
          firstName,
          lastName,
          employeeGroup: id === "emp-jhang" ? { id: "grp-pick", name: "Picking" } : null,
        })),
    });
  }
  if (path.startsWith("/api/inputs/daily")) {
    const employeeId = new URL(path, "http://t").searchParams.get("employeeId")!;
    return Promise.resolve(daily(employeeId));
  }
  if (path.startsWith("/api/row-completions/review-groups")) {
    return Promise.resolve({ date: PAST_DATE, groups: [{ employeeId: "emp-khen" }, { employeeId: "emp-larry" }] });
  }
  if (path.startsWith("/api/inputs/employee-activities")) {
    return Promise.resolve({
      activities: [
        { id: "act-plain", name: "Cleaning", normalSpeed: null, speedUnit: null, questions: [] },
        {
          id: "act-pick",
          name: "Picking",
          normalSpeed: null,
          speedUnit: null,
          questions: [
            { id: "q-row", questionType: "greenhouse_row", label: "Row", isRequired: true },
            { id: "q-bin", questionType: "carrier", label: "Bin", isRequired: true },
          ],
        },
      ],
    });
  }
  if (path === "/api/inputs/greenhouse-rows") {
    return Promise.resolve({
      lands: [{ id: "land", name: "GH1", phases: [{ id: "ph", name: "Phase 1", rows: [{ id: "row-12", rowNumber: 12 }] }] }],
    });
  }
  if (path === "/api/inputs/carriers") {
    return Promise.resolve({ carriers: [{ id: "bin-70", name: "Bin 70" }] });
  }
  if (path === "/api/inputs/activities" && options?.method === "POST") {
    const body = JSON.parse(options.body as string);
    if (postResult === "raceLost") {
      // Their phone synced work while the modal was open.
      onDay = [...onDay, body.employeeId];
      return Promise.reject(
        new ApiError(409, "This employee now has work recorded for this day, so nothing was added.", undefined, "EMPLOYEE_HAS_WORK")
      );
    }
    if (typeof postResult === "object") return Promise.reject(new ApiError(postResult.status, postResult.message));
    if (!onDay.includes(body.employeeId)) onDay = [...onDay, body.employeeId];
    return Promise.resolve(postResult === "duplicate" ? { ok: true, duplicate: true } : { ok: true });
  }
  return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
}

function daily(employeeId: string): DailyInputsResponse {
  return {
    employee: { id: employeeId, firstName: NAMES[employeeId][0], lastName: NAMES[employeeId][1], photoUrl: null },
    date: PAST_DATE,
    workStartTime: null,
    workEndTime: null,
    workStartOriginalTime: null,
    workStartCorrectedFrom: null,
    workStartManualEntry: null,
    runs: [],
    breaks: [],
    totals: { workedSeconds: 0, breakSeconds: 0, paidBreakSeconds: 0, unpaidBreakSeconds: 0 },
    canEdit: true,
  } as unknown as DailyInputsResponse;
}

function renderPage(employee = "emp-khen", date = PAST_DATE) {
  return render(
    <MemoryRouter initialEntries={[`/inputs?date=${date}&employee=${employee}`]}>
      <InputsPage />
    </MemoryRouter>
  );
}

const postCalls = () =>
  vi
    .mocked(api)
    .mock.calls.filter(([p, o]) => p === "/api/inputs/activities" && (o as RequestInit | undefined)?.method === "POST")
    .map(([, o]) => JSON.parse((o as RequestInit).body as string));
const optionCalls = () => vi.mocked(api).mock.calls.filter(([p]) => (p as string).startsWith("/api/inputs/employee-options"));

async function openModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Add employee to this day" }));
  return screen.findByRole("dialog");
}

// Picks an employee and the plain (no-question) activity and enters times.
async function fillPlain(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, employeeId: string, start: string, end?: string) {
  const employeeSelect = within(dialog).getByRole("combobox", { name: /Employee/ });
  await waitFor(() => expect(within(employeeSelect).getByRole("option", { name: NAMES[employeeId].join(" ") })).toBeInTheDocument());
  await user.selectOptions(employeeSelect, employeeId);
  const activitySelect = within(dialog).getByRole("combobox", { name: /Activity/ });
  await waitFor(() => expect(within(activitySelect).getByRole("option", { name: "Cleaning" })).toBeInTheDocument());
  await user.selectOptions(activitySelect, "act-plain");
  const startInput = within(dialog).getByLabelText(/Work start time/);
  await user.clear(startInput);
  await user.type(startInput, start);
  if (end) await user.type(within(dialog).getByLabelText(/End time/), end);
}

beforeEach(() => {
  role = "Administrator";
  onDay = ["emp-khen", "emp-larry"];
  postResult = "ok";
  vi.mocked(api).mockImplementation(mockApi as typeof api);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Inputs: Add employee to this day", () => {
  it("shows a + beside Review all employees with the label and tooltip, and keeps the Review badge", async () => {
    renderPage();
    const plus = await screen.findByRole("button", { name: "Add employee to this day" });
    expect(plus).toHaveAttribute("title", "Add employee to this day");
    const reviewAll = screen.getByRole("button", { name: /Review all employees/ });
    expect(await within(reviewAll).findByLabelText("2 pending speed reviews for all employees")).toBeInTheDocument();
    expect(plus.parentElement).toBe(reviewAll.parentElement);
  });

  it("is available to a Supervisor (no speed review) but not to an Employee", async () => {
    role = "Supervisor";
    renderPage();
    expect(await screen.findByRole("button", { name: "Add employee to this day" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Review all employees/ })).not.toBeInTheDocument();
    cleanup();

    role = "Employee";
    renderPage();
    await screen.findByText("Khen Lagto");
    expect(screen.queryByRole("button", { name: "Add employee to this day" })).not.toBeInTheDocument();
  });

  it("lists only employees without work that day, with no 'already on this day' options and no Reason field", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openModal(user);
    const employeeSelect = within(dialog).getByRole("combobox", { name: /Employee/ });
    await waitFor(() => expect(within(employeeSelect).getByRole("option", { name: "Jhang Cruz" })).toBeInTheDocument());
    const names = within(employeeSelect)
      .getAllByRole("option")
      .map((o) => o.textContent)
      .filter((n) => n !== "Select an employee");
    expect(names.sort()).toEqual(["Jhang Cruz", "Mia Reyes"]);
    expect(within(dialog).queryByText(/already on this day/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Reason/)).not.toBeInTheDocument();
    expect(optionCalls()[0][0]).toBe(`/api/inputs/employee-options?date=${PAST_DATE}`);
  });

  it("shows the empty state when every active employee already has work that day", async () => {
    onDay = Object.keys(NAMES);
    const user = userEvent.setup();
    renderPage();
    const dialog = await openModal(user);
    expect(await within(dialog).findByText("All active employees already have work recorded for this day.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Add to day" })).not.toBeInTheDocument();
    // The header's × is also labelled "Close"; this is the footer button.
    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "Close")!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("adds an employee with no work that day without a reason, requiring row and bin, then shows and selects them", async () => {
    const user = userEvent.setup();
    renderPage("emp-khen");
    expect(await screen.findByText("Khen Lagto")).toBeInTheDocument();
    expect(screen.queryByText("Jhang Cruz")).not.toBeInTheDocument();

    const dialog = await openModal(user);
    expect(within(dialog).getByText("Monday, October 5, 2026")).toBeInTheDocument();

    const employeeSelect = within(dialog).getByRole("combobox", { name: /Employee/ });
    await waitFor(() => expect(within(employeeSelect).getByRole("option", { name: "Jhang Cruz" })).toBeInTheDocument());
    await user.selectOptions(employeeSelect, "emp-jhang");

    const activitySelect = within(dialog).getByRole("combobox", { name: /Activity/ });
    await waitFor(() => expect(within(activitySelect).getByRole("option", { name: "Picking" })).toBeInTheDocument());
    await user.selectOptions(activitySelect, "act-pick");
    await user.type(within(dialog).getByLabelText(/Work start time/), "07:00:00");
    await user.type(within(dialog).getByLabelText(/End time/), "11:30:00");

    const save = within(dialog).getByRole("button", { name: "Add to day" });
    expect(save).toBeDisabled();
    const rowSelect = within(dialog).getByRole("combobox", { name: /Row/ });
    await waitFor(() => expect(within(rowSelect).getByRole("option", { name: "Row 12" })).toBeInTheDocument());
    await user.selectOptions(rowSelect, "row-12");
    expect(save).toBeDisabled();
    const binSelect = within(dialog).getByRole("combobox", { name: /Bin/ });
    await waitFor(() => expect(within(binSelect).getByRole("option", { name: "Bin 70" })).toBeInTheDocument());
    await user.selectOptions(binSelect, "bin-70");
    expect(save).toBeEnabled();

    await user.click(save);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const [body] = postCalls();
    expect(body).toMatchObject({
      employeeId: "emp-jhang",
      date: PAST_DATE,
      activityId: "act-pick",
      answers: [
        { questionId: "q-row", greenhouseRowId: "row-12" },
        { questionId: "q-bin", carrierId: "bin-70" },
      ],
      addEmployeeToDay: true,
    });
    expect(body).not.toHaveProperty("reason");
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.endTime).not.toBeNull();

    const jhangRow = await screen.findByRole("button", { name: /Jhang Cruz/ });
    await waitFor(() => expect(jhangRow).toHaveClass("inputs-employee-item-selected"));
    expect(await screen.findByText("Jhang Cruz added to this day.")).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some(([p]) => (p as string).includes("/api/inputs/daily?employeeId=emp-jhang"))).toBe(true)
    );
    // Further activities/breaks are then added from the normal day view.
    expect(await screen.findByRole("button", { name: "Add activity" })).toBeInTheDocument();
  });

  it("allows an in-progress entry (no end time) today", async () => {
    const user = userEvent.setup();
    renderPage("emp-khen", todayInAppTimezone());
    const dialog = await openModal(user);
    await fillPlain(user, dialog, "emp-mia", "00:00:01");
    expect(within(dialog).getByText("Leave blank if they're still working.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Add to day" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(postCalls()[0]).toMatchObject({ employeeId: "emp-mia", endTime: null, addEmployeeToDay: true });
    expect(await screen.findByText("Mia Reyes added to this day.")).toBeInTheDocument();
  });

  it("requires an end time after the start on a past day", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openModal(user);
    await fillPlain(user, dialog, "emp-jhang", "09:00:00");
    const save = within(dialog).getByRole("button", { name: "Add to day" });
    expect(within(dialog).getByText("Required for a past day.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/End time/), "08:00:00");
    expect(within(dialog).getByText("End time must be after the start time.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(postCalls()).toHaveLength(0);
  });

  it("explains and refreshes the list when the employee got work after the modal opened", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openModal(user);
    await fillPlain(user, dialog, "emp-jhang", "07:00:00", "09:00:00");
    expect(optionCalls()).toHaveLength(1);

    postResult = "raceLost";
    await user.click(within(dialog).getByRole("button", { name: "Add to day" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Jhang Cruz now has work recorded for this day, so nothing was added. The employee list has been refreshed."
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(optionCalls()).toHaveLength(2));
    const employeeSelect = within(dialog).getByRole("combobox", { name: /Employee/ });
    await waitFor(() => expect(within(employeeSelect).queryByRole("option", { name: "Jhang Cruz" })).not.toBeInTheDocument());
    expect(employeeSelect).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Add to day" })).toBeDisabled();
    expect(postCalls()).toHaveLength(1);
  });

  it("shows an overlap rejection in the modal, reuses the key for an identical retry and not for an edited one", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openModal(user);
    await fillPlain(user, dialog, "emp-jhang", "07:00:00", "09:00:00");

    postResult = { status: 409, message: "This time overlaps a break from 8:00 AM to 8:15 AM." };
    const save = within(dialog).getByRole("button", { name: "Add to day" });
    await user.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This time overlaps a break");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Same values again (e.g. a retry after a timeout): same key, and the
    // server's "already saved" answer closes the modal without a second entry.
    postResult = "duplicate";
    await user.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const [first, second] = postCalls();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(await screen.findByText("Jhang Cruz's work entry was already saved.")).toBeInTheDocument();

    // A fresh, different submission gets a new key.
    postResult = "ok";
    const dialog2 = await openModal(user);
    await fillPlain(user, dialog2, "emp-mia", "13:00:00", "14:00:00");
    await user.click(within(dialog2).getByRole("button", { name: "Add to day" }));
    await waitFor(() => expect(postCalls()).toHaveLength(3));
    expect(postCalls()[2].idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
