// @vitest-environment jsdom
//
// Inputs sidebar "Add employee to this day" (+ beside Review all employees):
// role visibility, the Review button and its badge staying intact, the
// picker listing employees with no entries on the date, required row/bin
// fields, the request sent to the shared manual-entry route (POST
// /api/inputs/activities with overlapPolicy "reject" and an idempotency
// key), selecting the employee afterwards, and overlap/duplicate handling.
// The server side of the same flow is server/src/routes/inputs.addEmployeeToDay.test.ts.
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
// Employees with entries on the date (the sidebar); Jhang starts without any.
let onDay: string[] = [];
// Next POST /activities result: "ok", "duplicate", or an error to reject with.
let postResult: "ok" | "duplicate" | { status: number; message: string } = "ok";

const NAMES: Record<string, [string, string]> = {
  "emp-khen": ["Khen", "Lagto"],
  "emp-larry": ["Larry", "Banguigui"],
  "emp-jhang": ["Jhang", "Cruz"],
};

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-admin", firstName: "Ada", lastName: "Admin", securityRole: role } }),
}));

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
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
      employees: Object.entries(NAMES).map(([id, [firstName, lastName]]) => ({
        id,
        firstName,
        lastName,
        employeeGroup: id === "emp-jhang" ? { id: "grp-pick", name: "Picking" } : null,
        hasEntriesOnDate: onDay.includes(id),
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

async function openModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Add employee to this day" }));
  return screen.findByRole("dialog");
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

  it("adds an employee with no work that day, requiring row and bin, then shows and selects them", async () => {
    const user = userEvent.setup();
    renderPage("emp-khen");
    expect(await screen.findByText("Khen Lagto")).toBeInTheDocument();
    expect(screen.queryByText("Jhang Cruz")).not.toBeInTheDocument();

    const dialog = await openModal(user);
    expect(within(dialog).getByText("Monday, October 5, 2026")).toBeInTheDocument();

    const employeeSelect = within(dialog).getByRole("combobox", { name: /Employee/ });
    await waitFor(() => expect(within(employeeSelect).getByRole("option", { name: "Jhang Cruz" })).toBeInTheDocument());
    expect(within(employeeSelect).getByRole("option", { name: "Khen Lagto (already on this day)" })).toBeInTheDocument();
    await user.selectOptions(employeeSelect, "emp-jhang");

    const activitySelect = await within(dialog).findByRole("combobox", { name: /Activity/ });
    await waitFor(() => expect(within(activitySelect).getByRole("option", { name: "Picking" })).toBeInTheDocument());
    await user.selectOptions(activitySelect, "act-pick");
    await user.type(within(dialog).getByLabelText(/Work start time/), "07:00:00");
    await user.type(within(dialog).getByLabelText(/End time/), "11:30:00");
    await user.type(within(dialog).getByLabelText(/Reason/), "Forgot phone");

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
      reason: "Forgot phone",
      overlapPolicy: "reject",
    });
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

  it("adds work for an employee already listed and reloads their selected day; end time optional today", async () => {
    const user = userEvent.setup();
    const today = todayInAppTimezone();
    renderPage("emp-khen", today);
    const dialog = await openModal(user);

    const employeeSelect = within(dialog).getByRole("combobox", { name: /Employee/ });
    await waitFor(() =>
      expect(within(employeeSelect).getByRole("option", { name: "Khen Lagto (already on this day)" })).toBeInTheDocument()
    );
    await user.selectOptions(employeeSelect, "emp-khen");
    const activitySelect = await within(dialog).findByRole("combobox", { name: /Activity/ });
    await waitFor(() => expect(within(activitySelect).getByRole("option", { name: "Cleaning" })).toBeInTheDocument());
    await user.selectOptions(activitySelect, "act-plain");
    const start = within(dialog).getByLabelText(/Work start time/);
    await user.clear(start);
    await user.type(start, "00:00:01");
    expect(within(dialog).getByText("Leave blank if they're still working.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), "Phone broken");

    const dailyCallsBefore = vi.mocked(api).mock.calls.filter(([p]) => (p as string).includes("employeeId=emp-khen")).length;
    await user.click(within(dialog).getByRole("button", { name: "Add to day" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(postCalls()[0]).toMatchObject({ employeeId: "emp-khen", endTime: null, overlapPolicy: "reject" });
    expect(await screen.findByText("Khen Lagto added to this day.")).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.filter(([p]) => (p as string).includes("employeeId=emp-khen")).length).toBeGreaterThan(
      dailyCallsBefore
    );
    expect(screen.getByRole("button", { name: /Khen Lagto/ })).toHaveClass("inputs-employee-item-selected");
  });

  it("requires an end time after the start on a past day", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openModal(user);
    const employeeSelect = within(dialog).getByRole("combobox", { name: /Employee/ });
    await waitFor(() => expect(within(employeeSelect).getByRole("option", { name: "Jhang Cruz" })).toBeInTheDocument());
    await user.selectOptions(employeeSelect, "emp-jhang");
    const activitySelect = await within(dialog).findByRole("combobox", { name: /Activity/ });
    await waitFor(() => expect(within(activitySelect).getByRole("option", { name: "Cleaning" })).toBeInTheDocument());
    await user.selectOptions(activitySelect, "act-plain");
    await user.type(within(dialog).getByLabelText(/Work start time/), "09:00:00");
    await user.type(within(dialog).getByLabelText(/Reason/), "Forgot phone");

    const save = within(dialog).getByRole("button", { name: "Add to day" });
    expect(within(dialog).getByText("Required for a past day.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/End time/), "08:00:00");
    expect(within(dialog).getByText("End time must be after the start time.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(postCalls()).toHaveLength(0);
  });

  it("shows an overlap rejection in the modal, reuses the key for an identical retry and not for an edited one", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openModal(user);
    const employeeSelect = within(dialog).getByRole("combobox", { name: /Employee/ });
    await waitFor(() => expect(within(employeeSelect).getByRole("option", { name: "Jhang Cruz" })).toBeInTheDocument());
    await user.selectOptions(employeeSelect, "emp-jhang");
    const activitySelect = await within(dialog).findByRole("combobox", { name: /Activity/ });
    await waitFor(() => expect(within(activitySelect).getByRole("option", { name: "Cleaning" })).toBeInTheDocument());
    await user.selectOptions(activitySelect, "act-plain");
    await user.type(within(dialog).getByLabelText(/Work start time/), "07:00:00");
    const end = within(dialog).getByLabelText(/End time/);
    await user.type(end, "09:00:00");
    await user.type(within(dialog).getByLabelText(/Reason/), "Forgot phone");

    postResult = { status: 409, message: "This time overlaps an activity from 8:00 AM to 10:00 AM." };
    const save = within(dialog).getByRole("button", { name: "Add to day" });
    await user.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This time overlaps an activity");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Same values again (e.g. a retry after a timeout): same key, and the
    // server's "already saved" answer closes the modal without a second entry.
    postResult = "duplicate";
    await user.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const [first, second] = postCalls();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(await screen.findByText("Jhang Cruz's work entry was already saved.")).toBeInTheDocument();

    // A fresh, edited submission gets a new key.
    postResult = "ok";
    const dialog2 = await openModal(user);
    const employeeSelect2 = within(dialog2).getByRole("combobox", { name: /Employee/ });
    await waitFor(() => expect(within(employeeSelect2).getByRole("option", { name: /Jhang Cruz/ })).toBeInTheDocument());
    await user.selectOptions(employeeSelect2, "emp-jhang");
    const activitySelect2 = await within(dialog2).findByRole("combobox", { name: /Activity/ });
    await waitFor(() => expect(within(activitySelect2).getByRole("option", { name: "Cleaning" })).toBeInTheDocument());
    await user.selectOptions(activitySelect2, "act-plain");
    await user.type(within(dialog2).getByLabelText(/Work start time/), "13:00:00");
    await user.type(within(dialog2).getByLabelText(/End time/), "14:00:00");
    await user.type(within(dialog2).getByLabelText(/Reason/), "Forgot phone");
    await user.click(within(dialog2).getByRole("button", { name: "Add to day" }));
    await waitFor(() => expect(postCalls()).toHaveLength(3));
    expect(postCalls()[2].idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
