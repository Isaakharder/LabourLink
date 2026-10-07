// @vitest-environment jsdom
//
// Setup > Row Review: shows the saved Row review window, lets an
// Administrator save a positive whole number of days (client-side
// validation mirrors the server's), surfaces the server's error, and is
// view-only for a Manager. Server behaviour: server/src/routes/rowReviewWindow.test.ts.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowReviewTab } from "./RowReviewTab";
import { api } from "../../../lib/api";

let role = "Administrator";
let saved = 7;
let failNextPut: string | null = null;

vi.mock("../../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "me", firstName: "Isaak", lastName: "Harder", securityRole: role } }),
}));

vi.mock("../../../lib/api", () => {
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
      const method = options?.method ?? "GET";
      if (path === "/api/row-completions/review-window" && method === "GET") {
        return Promise.resolve({ rowReviewWindowDays: saved });
      }
      if (path === "/api/row-completions/review-window" && method === "PUT") {
        if (failNextPut) {
          const msg = failNextPut;
          failNextPut = null;
          return Promise.reject(new ApiError(400, msg));
        }
        saved = JSON.parse(options!.body as string).rowReviewWindowDays;
        return Promise.resolve({ rowReviewWindowDays: saved });
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${method} ${path}`));
    }),
  };
});

const apiMock = vi.mocked(api);
const putCalls = () => apiMock.mock.calls.filter(([, o]) => o?.method === "PUT");

beforeEach(() => {
  role = "Administrator";
  saved = 7;
  failNextPut = null;
  apiMock.mockClear();
});
afterEach(cleanup);

describe("Setup > Row Review", () => {
  it("shows the saved window (default 7) with an explanation of the rule", async () => {
    render(<RowReviewTab />);
    const input = await screen.findByLabelText("Row review window (calendar days)");
    expect(input).toHaveValue(7);
    expect(screen.getByText(/fewer than this many calendar days apart/)).toBeInTheDocument();
    expect(screen.getByText(/confirmed row completions never change/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the recalculation warning beside the setting, linked to the input", async () => {
    render(<RowReviewTab />);
    const input = await screen.findByLabelText("Row review window (calendar days)");
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(
      "Changing this window recalculates unresolved historical visits and may change past speeds and totals. Confirmed reviews remain unchanged."
    );
    expect(input).toHaveAccessibleDescription(note.textContent!);
  });

  it("lets an Administrator save a new whole number of days", async () => {
    const user = userEvent.setup();
    render(<RowReviewTab />);
    const input = await screen.findByLabelText("Row review window (calendar days)");
    await user.clear(input);
    await user.type(input, "3");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(putCalls()).toHaveLength(1);
    expect(JSON.parse(putCalls()[0][1]!.body as string)).toEqual({ rowReviewWindowDays: 3 });
    expect(input).toHaveValue(3);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it.each(["0", "1.5", "366", "-2"])("rejects %s without calling the server", async (value) => {
    const user = userEvent.setup();
    render(<RowReviewTab />);
    const input = await screen.findByLabelText("Row review window (calendar days)");
    await user.clear(input);
    await user.type(input, value);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a whole number of days from 1 to 365")).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the old value saved", async () => {
    const user = userEvent.setup();
    failNextPut = "Row review window must be a whole number of days from 1 to 365";
    render(<RowReviewTab />);
    const input = await screen.findByLabelText("Row review window (calendar days)");
    await user.clear(input);
    await user.type(input, "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(failNextPut ?? "Row review window must be a whole number of days from 1 to 365")).toBeInTheDocument();
    expect(saved).toBe(7);
  });

  it("is view-only for a Manager", async () => {
    role = "Manager";
    saved = 10;
    render(<RowReviewTab />);
    const input = await screen.findByLabelText("Row review window (calendar days)");
    expect(input).toHaveValue(10);
    expect(input).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByText("Only an Administrator can change this.")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/Confirmed reviews remain unchanged/);
  });

  it("shows nothing to an Employee and never calls the server", async () => {
    role = "Employee";
    render(<RowReviewTab />);
    expect(screen.getByText("You don't have access to row review settings.")).toBeInTheDocument();
    await waitFor(() => expect(apiMock).not.toHaveBeenCalled());
  });
});
