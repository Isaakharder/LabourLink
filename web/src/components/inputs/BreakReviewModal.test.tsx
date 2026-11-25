// @vitest-environment jsdom
//
// The midnight-closed break review dialog: nothing is saved without a typed
// reason and an explicit confirmation; a correction sends the new times, a
// "right as recorded" review sends only the confirmation; the paid-hours
// effect of shortening an unpaid break is shown before saving.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreakReviewListModal, BreakReviewModal } from "./BreakReviewModal";
import { api } from "../../lib/api";
import { combineDateAndTimeToUtcIso } from "../../lib/timezone";

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { ApiError, api: vi.fn(() => Promise.resolve({ ok: true })) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(api).mockImplementation(() => Promise.resolve({ ok: true }));
});

const DAY = "2026-11-10";
const review = {
  breakId: "brk-1",
  employeeName: "Jeffrey S",
  date: DAY,
  startedAt: combineDateAndTimeToUtcIso(DAY, "12:00:00"),
  endedAt: combineDateAndTimeToUtcIso("2026-11-11", "00:00:00"),
  durationSeconds: 12 * 3600,
  isPaid: false,
};

function patchBody() {
  const call = vi.mocked(api).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

describe("BreakReviewModal", () => {
  it("needs a reason and the confirmation before it can save a correction, and shows the paid-hours effect", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const { container } = render(<BreakReviewModal review={review} onClose={vi.fn()} onSaved={onSaved} />);
    const save = screen.getByRole("button", { name: "Save review" });
    expect(save).toBeDisabled();

    const [startInput, endInput] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="time"]'));
    expect(startInput.value).toBe("12:00:00");
    fireEvent.change(endInput, { target: { value: "12:30:00" } });
    expect(screen.getByText(/paid hours for this day go up by about 11:30:00/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "Confirmed with Jeffrey");
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("Break corrected."));
    const body = patchBody();
    const patchCall = vi.mocked(api).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")!;
    expect(patchCall[0]).toBe("/api/inputs/breaks/brk-1");
    expect(body).toMatchObject({ confirmed: true, reason: "Confirmed with Jeffrey" });
    expect(Date.parse(body.endTime) - Date.parse(body.startTime)).toBe(30 * 60_000);
    expect(body.confirmAsRecorded).toBeUndefined();
  });

  it("treats a break with no paid flag as unpaid, as payroll does", () => {
    const { container } = render(<BreakReviewModal review={{ ...review, isPaid: null }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(container.querySelectorAll<HTMLInputElement>('input[type="time"]')[1], { target: { value: "12:30:00" } });
    expect(screen.getByText(/paid hours for this day go up by about 11:30:00/)).toBeInTheDocument();
  });

  it("'right as recorded' sends only the confirmation and reason, no times", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<BreakReviewModal review={review} onClose={vi.fn()} onSaved={onSaved} />);
    await user.click(screen.getByRole("radio", { name: /right as recorded/i }));
    await user.type(screen.getByRole("textbox"), "He went home at noon");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("Break confirmed as recorded."));
    expect(patchBody()).toEqual({ confirmAsRecorded: true, confirmed: true, reason: "He went home at noon" });
  });

  it("an end before the start can't be saved", async () => {
    const user = userEvent.setup();
    const { container } = render(<BreakReviewModal review={review} onClose={vi.fn()} onSaved={vi.fn()} />);
    const endInput = container.querySelectorAll<HTMLInputElement>('input[type="time"]')[1];
    fireEvent.change(endInput, { target: { value: "11:00:00" } });
    await user.type(screen.getByRole("textbox"), "typo");
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled();
    expect(screen.getByText(/end must be after the start/i)).toBeInTheDocument();
  });
});

describe("BreakReviewModal — warnings for conflicting records", () => {
  it("shows which work entries the correction would change, from the Inputs correction preview", async () => {
    vi.mocked(api).mockImplementation((path: string) =>
      path.endsWith("/correction-preview")
        ? Promise.resolve({ messages: ["This correction will shorten Picking Peppers from 12:00 PM to 12:30 PM and remove 30 minutes from worked time."] })
        : Promise.resolve({ ok: true })
    );
    const { container } = render(<BreakReviewModal review={review} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(container.querySelectorAll<HTMLInputElement>('input[type="time"]')[1], { target: { value: "12:30:00" } });
    expect(await screen.findByText(/will shorten Picking Peppers/)).toBeInTheDocument();
    const previewCall = vi.mocked(api).mock.calls.find(([p]) => String(p).endsWith("/correction-preview"))!;
    expect(previewCall[0]).toBe("/api/inputs/breaks/brk-1/correction-preview");
    expect((previewCall[1] as RequestInit).method).toBe("POST");
  });

  it("a clash with another break blocks Save and says why", async () => {
    const { ApiError } = await import("../../lib/api");
    vi.mocked(api).mockImplementation((path: string) =>
      path.endsWith("/correction-preview")
        ? Promise.reject(new (ApiError as any)(409, "The corrected break overlaps another break (3:00 PM - 3:15 PM)"))
        : Promise.resolve({ ok: true })
    );
    const user = userEvent.setup();
    const { container } = render(<BreakReviewModal review={review} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(container.querySelectorAll<HTMLInputElement>('input[type="time"]')[1], { target: { value: "15:10:00" } });
    expect(await screen.findByText(/overlaps another break/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "Checked with him");
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled();
  });

  it("'right as recorded' warns when work is recorded during the break", async () => {
    const user = userEvent.setup();
    render(<BreakReviewModal review={{ ...review, overlappedWorkSeconds: 3 * 3600 }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: /right as recorded/i }));
    expect(screen.getByText(/3:00:00 of work is recorded during this break/)).toBeInTheDocument();
  });
});

describe("BreakReviewListModal", () => {
  it("lists each outstanding break with the work recorded during it, and opens one", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const c = { ...review, employeeId: "e1", name: "Lunch", overlappedWorkSeconds: 3 * 3600 };
    render(<BreakReviewListModal cases={[c]} onOpen={onOpen} onClose={vi.fn()} />);
    expect(screen.getByText("Jeffrey S")).toBeInTheDocument();
    expect(screen.getByText("3:00:00")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(onOpen).toHaveBeenCalledWith(c);
  });

  it("says so when nothing needs review", () => {
    render(<BreakReviewListModal cases={[]} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("No breaks need review.")).toBeInTheDocument();
  });
});
