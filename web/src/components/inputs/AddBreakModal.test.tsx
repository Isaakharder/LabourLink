// @vitest-environment jsdom
//
// Tests the simplified Add Break modal: selecting a preset ("configured")
// break type auto-fills its start/end/paid-status and hides the manual time
// fields, showing a plain-language summary instead; only the selected
// break-type id is ever sent to the server for a preset (never the client's
// own idea of its time — the server, POST /breaks, is the sole authority);
// Custom keeps the original editable-fields, exact-time behavior; and a
// preset already present in today's already-loaded breaks is marked
// "Already added" and can't be selected. Same api() mocking convention as
// RowCompletionReviewModal.test.tsx / InputsPage.switching.test.tsx.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddBreakModal } from "./AddBreakModal";
import { ApiError } from "../../lib/api";
import { EmployeeBreakItemOption } from "../../lib/inputsTypes";

let employeeBreakItemsResponse: { breakProfile: { id: string; name: string } | null; items: EmployeeBreakItemOption[] };
let postBreakStatus: number | null; // null = succeed; otherwise reject with this status
let postBreakMessage: string;
let postBreakResponseBody: any = { ok: true };
let lastPostBreakBody: any = null;

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
      if (path.startsWith("/api/inputs/employee-break-items")) {
        return Promise.resolve(employeeBreakItemsResponse);
      }
      if (path === "/api/inputs/breaks" && options?.method === "POST") {
        lastPostBreakBody = options?.body ? JSON.parse(options.body as string) : null;
        if (postBreakStatus !== null) {
          return Promise.reject(new ApiError(postBreakStatus, postBreakMessage));
        }
        // The server returns 200 (not an error) for an idempotent
        // already-exists no-op, and api() only ever rejects on a non-2xx
        // status — this mock returning normally for both the 200
        // already_exists case and the 201 created case is exactly what
        // makes that distinction invisible (and irrelevant) to the caller.
        return Promise.resolve(postBreakResponseBody);
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

const lunchItem: EmployeeBreakItemOption = { id: "item-lunch", name: "Lunch", startTime: "12:00:00", endTime: "13:00:00", isPaid: false };
const morningItem: EmployeeBreakItemOption = { id: "item-morning", name: "Morning", startTime: "09:00:00", endTime: "09:15:00", isPaid: false };
const afternoonItem: EmployeeBreakItemOption = { id: "item-afternoon", name: "Afternoon", startTime: "15:00:00", endTime: "15:15:00", isPaid: true };

function renderModal(overrides: { breaks?: { breakProfileItemId: string | null }[]; runs?: any[] } = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const utils = render(
    <AddBreakModal
      employeeId="emp-1"
      employeeName="Alice Anderson"
      date="2026-08-11"
      runs={overrides.runs ?? []}
      breaks={overrides.breaks ?? []}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
  return { ...utils, onClose, onCreated };
}

beforeEach(() => {
  employeeBreakItemsResponse = {
    breakProfile: { id: "profile-1", name: "Full Breaks" },
    items: [morningItem, lunchItem, afternoonItem],
  };
  postBreakStatus = null;
  postBreakMessage = "";
  postBreakResponseBody = { ok: true };
  lastPostBreakBody = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddBreakModal", () => {
  it("lists every preset in 12-hour time plus Custom, and loads without error", async () => {
    renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);
    expect(screen.getByText(/Morning \(9:00 AM–9:15 AM, Unpaid\)/)).toBeInTheDocument();
    expect(screen.getByText(/Afternoon \(3:00 PM–3:15 PM, Paid\)/)).toBeInTheDocument();
    expect(screen.getByText("Custom (not on Full Breaks)")).toBeInTheDocument();
  });

  it("selecting a preset auto-fills its configured time, shows the summary, and hides the manual time fields", async () => {
    renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Break type/), "item-lunch");

    // The example summary format from the spec.
    await screen.findByText("12:00 PM–1:00 PM · 1 hour · Unpaid");
    expect(screen.queryByLabelText(/Start time/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/End time/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Paid or unpaid/)).not.toBeInTheDocument();
  });

  it("selecting Custom (not on Full Breaks) shows the editable start/end fields and paid/unpaid choice", async () => {
    renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Break type/), "item-lunch");
    await screen.findByText("12:00 PM–1:00 PM · 1 hour · Unpaid");

    await user.selectOptions(screen.getByLabelText(/Break type/), "__custom__");
    expect(screen.getByLabelText(/Start time/)).toBeInTheDocument();
    expect(screen.getByLabelText(/End time/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Paid or unpaid/)).toBeInTheDocument();
    // Switching away from a preset clears its leftover time rather than
    // silently carrying it into a Custom submission the admin never typed.
    expect(screen.queryByText("12:00 PM–1:00 PM · 1 hour · Unpaid")).not.toBeInTheDocument();
  });

  it("submitting a preset sends only the break-type id — never a client-computed time or paid status", async () => {
    const { onCreated } = renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Break type/), "item-lunch");
    await screen.findByText("12:00 PM–1:00 PM · 1 hour · Unpaid");
    await user.click(screen.getByRole("button", { name: "Add Break" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(lastPostBreakBody).toEqual({ employeeId: "emp-1", date: "2026-08-11", breakProfileItemId: "item-lunch" });
  });

  it("submitting Custom sends the exact typed time and chosen paid status, combined with the selected date", async () => {
    const { onCreated } = renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Break type/), "__custom__");
    await user.type(screen.getByLabelText(/Start time/), "1330");
    await user.type(screen.getByLabelText(/End time/), "1345");
    await user.selectOptions(screen.getByLabelText(/Paid or unpaid/), "paid");
    await user.click(screen.getByRole("button", { name: "Add Break" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(lastPostBreakBody.employeeId).toBe("emp-1");
    expect(lastPostBreakBody.date).toBe("2026-08-11");
    expect(lastPostBreakBody.isPaid).toBe(true);
    expect(lastPostBreakBody.breakProfileItemId).toBeUndefined();
    expect(typeof lastPostBreakBody.startTime).toBe("string");
    expect(typeof lastPostBreakBody.endTime).toBe("string");
  });

  it("marks a preset already added today as 'Already added' and disabled in the list", async () => {
    renderModal({ breaks: [{ breakProfileItemId: "item-lunch" }] });
    await screen.findByText(/Lunch.*Already added/);
    const lunchOption = screen.getByRole("option", { name: /Lunch/ }) as HTMLOptionElement;
    expect(lunchOption.disabled).toBe(true);
    // A disabled <option> can't be selected via a native <select> at all —
    // the dropdown stays on the placeholder until a real choice is made.
    expect(screen.getByLabelText(/Break type/)).toHaveValue("");
  });

  it("shows the non-blocking split preview when the resolved preset time overlaps an existing activity", async () => {
    renderModal({
      runs: [{ activityName: "General", startedAt: "2026-08-11T15:00:00.000Z", endedAt: "2026-08-11T19:00:00.000Z" }],
    });
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);
    const user = userEvent.setup();
    // 12:00 PM Toronto (EDT) = 16:00 UTC, inside the 15:00-19:00 UTC run.
    await user.selectOptions(screen.getByLabelText(/Break type/), "item-lunch");

    await screen.findByText(/This will split General/);
  });

  it("treats a server-reported already_exists idempotent result as success — closes/refreshes, never shows an error", async () => {
    postBreakResponseBody = {
      ok: true,
      result: "already_exists",
      break: { id: "existing-break-id", startedAt: "2026-08-11T16:00:00.000Z", endedAt: "2026-08-11T17:00:00.000Z", isPaid: false },
    };
    const { onCreated } = renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Break type/), "item-lunch");
    await screen.findByText("12:00 PM–1:00 PM · 1 hour · Unpaid");
    await user.click(screen.getByRole("button", { name: "Add Break" }));

    // The 200 already_exists response is a success as far as api() and this
    // modal are concerned — onCreated (close/refresh) fires exactly like a
    // genuine 201 creation would, and no error banner ever appears.
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  it("shows the server's rejection message and re-enables Save when the API call fails", async () => {
    postBreakStatus = 409;
    postBreakMessage = "This break has already been added for this employee on this date";
    const { onCreated } = renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Break type/), "item-lunch");
    await screen.findByText("12:00 PM–1:00 PM · 1 hour · Unpaid");
    await user.click(screen.getByRole("button", { name: "Add Break" }));

    await screen.findByText("This break has already been added for this employee on this date");
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add Break" })).not.toBeDisabled();
  });
});
