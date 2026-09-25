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
let postAddAllStatus: number | null; // null = succeed; otherwise reject with this status
let postAddAllMessage: string;
let postAddAllResponseBody: any = { ok: true, added: [] };
let lastPostAddAllBody: any = null;

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
      if (path === "/api/inputs/breaks/add-all" && options?.method === "POST") {
        lastPostAddAllBody = options?.body ? JSON.parse(options.body as string) : null;
        if (postAddAllStatus !== null) {
          return Promise.reject(new ApiError(postAddAllStatus, postAddAllMessage));
        }
        return Promise.resolve(postAddAllResponseBody);
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

const lunchItem: EmployeeBreakItemOption = { id: "item-lunch", name: "Lunch", startTime: "12:00:00", endTime: "13:00:00", isPaid: false };
const morningItem: EmployeeBreakItemOption = { id: "item-morning", name: "Morning", startTime: "09:00:00", endTime: "09:15:00", isPaid: false };
const afternoonItem: EmployeeBreakItemOption = { id: "item-afternoon", name: "Afternoon", startTime: "15:00:00", endTime: "15:15:00", isPaid: true };

function renderModal(
  overrides: {
    breaks?: { breakProfileItemId: string | null; startedAt: string; endedAt: string | null }[];
    runs?: any[];
    workStartTime?: string | null;
    workEndTime?: string | null;
  } = {}
) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const utils = render(
    <AddBreakModal
      employeeId="emp-1"
      employeeName="Alice Anderson"
      date="2026-08-11"
      runs={overrides.runs ?? []}
      breaks={overrides.breaks ?? []}
      workStartTime={overrides.workStartTime ?? null}
      workEndTime={overrides.workEndTime ?? null}
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
  postAddAllStatus = null;
  postAddAllMessage = "";
  postAddAllResponseBody = { ok: true, added: [] };
  lastPostAddAllBody = null;
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
    renderModal({
      breaks: [{ breakProfileItemId: "item-lunch", startedAt: "2026-08-11T16:00:00.000Z", endedAt: "2026-08-11T17:00:00.000Z" }],
    });
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

  // jsdom never lays anything out (see EmploymentTimelineGraph.test.tsx's
  // own comment on the same limitation), so these can't measure real
  // pixels/scrollbars. Instead they pin down the structural contract the
  // CSS in index.css actually relies on: the wider desktop panel, the
  // overflow-safe grid classes, Break type's full-width span, and the
  // pinned footer — regressing any of these silently reintroduces the
  // clipped dropdown / white-on-white button / scrolling footer bugs this
  // modal was fixed for, even though no unit test can literally screenshot
  // the result.
  it("renders the wider desktop panel with the overflow-safe grid classes and Break type spanning the full width", async () => {
    renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    // .modal-panel-wide (index.css) caps the panel at 720px — within the
    // requested ~700-760px range — instead of the cramped 480px default.
    expect(screen.getByRole("dialog").className).toContain("modal-panel-wide");

    // .add-break-grid (scoped, not the shared .employee-form-grid) is what
    // carries min-width: 0 on the grid and its fields so a long employee
    // name or option label can shrink to its track instead of forcing a
    // horizontal scrollbar; .employee-form-grid is kept alongside it so the
    // grid still collapses to one column under the existing 900px
    // responsive breakpoint on narrow screens.
    const grid = document.querySelector(".add-break-grid");
    expect(grid).not.toBeNull();
    expect(grid).toHaveClass("employee-form-grid");

    // Break type carries the longest content in the form (name + time
    // range + paid/unpaid) — .add-break-type-field spans the full grid
    // width so it's never squeezed into a half-width column and clipped.
    const breakTypeField = screen.getByLabelText(/Break type/).closest("label");
    expect(breakTypeField).toHaveClass("add-break-type-field");
  });

  it("keeps the Add Break button readable (employee-form-save, not the shared toolbar button that goes invisible in this footer) whether enabled or disabled", async () => {
    renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    // Nothing selected yet — the button is disabled but must still clearly
    // read "Add Break", not vanish or fall back to "Save".
    const disabledButton = screen.getByRole("button", { name: "Add Break" });
    expect(disabledButton).toBeDisabled();
    expect(disabledButton).toHaveTextContent("Add Break");
    // .employees-add-button has no :disabled styling of its own and, worse,
    // loses its background to `.employee-form-actions button` inside this
    // footer (white-on-white) — .employee-form-save is the shared,
    // !important-backed primary-button class used by every other
    // cleaned-up LabourLink modal, which is immune to that override.
    expect(disabledButton.className).toContain("employee-form-save");
    expect(disabledButton.className).not.toContain("employees-add-button");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Break type/), "item-lunch");
    await screen.findByText("12:00 PM–1:00 PM · 1 hour · Unpaid");

    const enabledButton = screen.getByRole("button", { name: "Add Break" });
    expect(enabledButton).not.toBeDisabled();
    expect(enabledButton).toHaveTextContent("Add Break");
    expect(enabledButton.className).toContain("employee-form-save");
  });

  it("pins Cancel/Add Break in the modal's footer, outside the scrollable form body, wired to the form by id", async () => {
    renderModal();
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    const addBreakButton = screen.getByRole("button", { name: "Add Break" });
    // Rendered via Modal's `footer` prop (modal-footer, flex-shrink: 0,
    // outside modal-body's own overflow-y: auto region) so it — and
    // Cancel next to it — stay reachable regardless of how tall the form
    // body gets, including at 125%/150% browser zoom on a laptop screen.
    expect(addBreakButton.closest(".modal-footer")).not.toBeNull();
    expect(addBreakButton.closest("form")).toBeNull();
    // Still submits the form it visually belongs to via the standard HTML
    // form= association, since it isn't a DOM descendant of it any more.
    expect(addBreakButton).toHaveAttribute("form", "add-break-form");

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton.closest(".modal-footer")).not.toBeNull();
  });
});

// "Add All Applicable Breaks" — the employee's recorded work start/finish
// (workStartTime/workEndTime, GET /daily) define the window; every preset
// whose full start/end falls inside it, isn't already recorded, and doesn't
// overlap an already-recorded break (preset or custom) is "missing". All
// times below use the same Toronto (EDT, UTC-4 in August) conversion the
// existing tests above already document: e.g. Lunch 12:00 PM-1:00 PM
// Toronto = 16:00-17:00 UTC.
describe("AddBreakModal — Add All Applicable Breaks", () => {
  const FULL_SHIFT_START = "2026-08-11T10:45:00.000Z"; // 6:45 AM Toronto
  const FULL_SHIFT_END = "2026-08-11T22:00:00.000Z"; // 6:00 PM Toronto

  it("a full shift finds all three presets and previews their times", async () => {
    renderModal({ workStartTime: FULL_SHIFT_START, workEndTime: FULL_SHIFT_END });
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    expect(screen.getByRole("button", { name: "Add All Breaks (3)" })).not.toBeDisabled();
    expect(screen.getByText("3 missing breaks: 9:00–9:15, 12:00–1:00, 3:00–3:15")).toBeInTheDocument();
  });

  it("a partial shift covering only lunch finds just the one applicable preset", async () => {
    renderModal({ workStartTime: "2026-08-11T15:30:00.000Z", workEndTime: "2026-08-11T17:30:00.000Z" });
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    expect(screen.getByRole("button", { name: "Add All Breaks (1)" })).not.toBeDisabled();
    expect(screen.getByText("1 missing break: 12:00–1:00")).toBeInTheDocument();
  });

  it("excludes a preset already recorded for this employee/date", async () => {
    renderModal({
      workStartTime: FULL_SHIFT_START,
      workEndTime: FULL_SHIFT_END,
      breaks: [{ breakProfileItemId: "item-lunch", startedAt: "2026-08-11T16:00:00.000Z", endedAt: "2026-08-11T17:00:00.000Z" }],
    });
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    expect(screen.getByRole("button", { name: "Add All Breaks (2)" })).not.toBeDisabled();
    expect(screen.getByText("2 missing breaks: 9:00–9:15, 3:00–3:15")).toBeInTheDocument();
  });

  it("excludes a preset that overlaps an already-recorded CUSTOM break, even with no matching breakProfileItemId", async () => {
    renderModal({
      workStartTime: FULL_SHIFT_START,
      workEndTime: FULL_SHIFT_END,
      // A custom break from 2:45-3:05 PM Toronto (18:45-19:05 UTC) overlaps
      // the Afternoon preset's 3:00-3:15 PM slot (19:00-19:15 UTC) without
      // sharing its breakProfileItemId at all — the by-id duplicate check
      // alone would miss this.
      breaks: [{ breakProfileItemId: null, startedAt: "2026-08-11T18:45:00.000Z", endedAt: "2026-08-11T19:05:00.000Z" }],
    });
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    expect(screen.getByRole("button", { name: "Add All Breaks (2)" })).not.toBeDisabled();
    expect(screen.getByText("2 missing breaks: 9:00–9:15, 12:00–1:00")).toBeInTheDocument();
  });

  it("disables the button and shows 'No missing breaks' once every applicable break is already present", async () => {
    renderModal({
      workStartTime: FULL_SHIFT_START,
      workEndTime: FULL_SHIFT_END,
      breaks: [
        { breakProfileItemId: "item-morning", startedAt: "2026-08-11T13:00:00.000Z", endedAt: "2026-08-11T13:15:00.000Z" },
        { breakProfileItemId: "item-lunch", startedAt: "2026-08-11T16:00:00.000Z", endedAt: "2026-08-11T17:00:00.000Z" },
        { breakProfileItemId: "item-afternoon", startedAt: "2026-08-11T19:00:00.000Z", endedAt: "2026-08-11T19:15:00.000Z" },
      ],
    });
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    const button = screen.getByRole("button", { name: "No missing breaks" });
    expect(button).toBeDisabled();
    // The preview paragraph (distinct from the button's own "No missing
    // breaks" label, which itself contains the substring "missing break").
    expect(screen.queryByText(/^\d+ missing breaks?:/)).not.toBeInTheDocument();
  });

  it("has no work window yet (no work recorded) — treated the same as no missing breaks", async () => {
    renderModal({ workStartTime: null, workEndTime: null });
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    expect(screen.getByRole("button", { name: "No missing breaks" })).toBeDisabled();
  });

  it("clicking Add All Breaks posts to /breaks/add-all with just employeeId/date and refreshes on success", async () => {
    const { onCreated } = renderModal({ workStartTime: FULL_SHIFT_START, workEndTime: FULL_SHIFT_END });
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add All Breaks (3)" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(lastPostAddAllBody).toEqual({ employeeId: "emp-1", date: "2026-08-11" });
  });

  it("shows the server's error and re-enables the button when the bulk add fails (e.g. a rolled-back batch)", async () => {
    postAddAllStatus = 409;
    postAddAllMessage = "One of these breaks conflicts with an existing entry";
    const { onCreated } = renderModal({ workStartTime: FULL_SHIFT_START, workEndTime: FULL_SHIFT_END });
    await screen.findByText(/Lunch \(12:00 PM–1:00 PM, Unpaid\)/);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add All Breaks (3)" }));

    await screen.findByText("One of these breaks conflicts with an existing entry");
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add All Breaks (3)" })).not.toBeDisabled();
  });
});
