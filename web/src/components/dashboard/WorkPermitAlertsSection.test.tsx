// @vitest-environment jsdom
//
// Covers the Dashboard Work Permit Alerts section: severity styling, the
// "no oversized empty section" rule, Acknowledge/Renewed/Cancel alert
// button behavior (including disabling while a request is in flight — a
// double-click must never fire twice), and Renewed's client-side
// later-than-current-expiry validation. Server-side behavior (idempotent
// acknowledge, permission enforcement, weekly recurrence, DB constraints)
// is covered by workPermits.routes.test.ts — this file is the UI's own
// contract with that API, not a re-test of the API itself.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkPermitAlertsSection } from "./WorkPermitAlertsSection";
import { WorkPermitAlert } from "../../lib/workPermitTypes";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let alertsResponse: { alerts: WorkPermitAlert[] };
let postCalls: { path: string; body: unknown; deferred: Deferred<unknown> }[] = [];

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
      if (path === "/api/dashboard/work-permit-alerts") return Promise.resolve(alertsResponse);
      if (options?.method === "POST") {
        const deferred = createDeferred<unknown>();
        postCalls.push({ path, body: options.body ? JSON.parse(options.body as string) : undefined, deferred });
        return deferred.promise;
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

function makeAlert(overrides: Partial<WorkPermitAlert> = {}): WorkPermitAlert {
  return {
    employeeId: "emp-1",
    employeeName: "Marcelino Besa",
    photoUrl: null,
    expiryDate: "2027-02-25",
    remainingDays: 180,
    severity: "amber",
    leadMonths: 6,
    leadDays: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  postCalls = [];
});

describe("WorkPermitAlertsSection", () => {
  it("renders nothing (not an empty oversized section) when there are zero alerts", async () => {
    alertsResponse = { alerts: [] };
    const { container } = render(<WorkPermitAlertsSection />);
    await act(async () => {});
    expect(container.querySelector(".work-permit-alerts-section")).not.toBeInTheDocument();
  });

  it("shows the headline, exact expiry date, and remaining time for an amber (>90 day) alert", async () => {
    alertsResponse = { alerts: [makeAlert()] };
    render(<WorkPermitAlertsSection />);
    expect(await screen.findByText(/Work permit expiring in/)).toBeInTheDocument();
    expect(screen.getByText(/Marcelino Besa's work permit expires February 25, 2027/)).toBeInTheDocument();
    const card = document.querySelector(".work-permit-alert-card");
    expect(card).toHaveClass("work-permit-alert-amber");
  });

  it("applies the orange class for a 30-90 day alert and the red class for a <30 day alert", async () => {
    alertsResponse = {
      alerts: [makeAlert({ employeeId: "orange-emp", severity: "orange", remainingDays: 60 }), makeAlert({ employeeId: "red-emp", severity: "red", remainingDays: 10 })],
    };
    render(<WorkPermitAlertsSection />);
    await screen.findAllByText(/Work permit expiring in/);
    const cards = document.querySelectorAll(".work-permit-alert-card");
    expect(cards[0]).toHaveClass("work-permit-alert-orange");
    expect(cards[1]).toHaveClass("work-permit-alert-red");
  });

  it("shows 'Overdue by X days' for an expired permit, styled red", async () => {
    alertsResponse = { alerts: [makeAlert({ severity: "expired", remainingDays: -5 })] };
    render(<WorkPermitAlertsSection />);
    expect(await screen.findByText("Work permit overdue by 5 days")).toBeInTheDocument();
    expect(document.querySelector(".work-permit-alert-card")).toHaveClass("work-permit-alert-expired");
  });

  it("Acknowledge disables the button while the request is in flight, and a repeated click before it resolves never fires a second request", async () => {
    alertsResponse = { alerts: [makeAlert()] };
    const user = userEvent.setup();
    render(<WorkPermitAlertsSection />);
    const ackButton = await screen.findByRole("button", { name: "Acknowledge" });

    await user.click(ackButton);
    expect(ackButton).toBeDisabled();
    expect(postCalls.length).toBe(1);

    // A second click while still disabled/processing must not be possible
    // through the UI — confirm no second request was ever queued.
    await user.click(ackButton).catch(() => {});
    expect(postCalls.length).toBe(1);

    await act(async () => {
      postCalls[0].deferred.resolve({});
    });
  });

  it("Renewed rejects a date that is not later than the current expiry, without calling the API", async () => {
    alertsResponse = { alerts: [makeAlert({ expiryDate: "2027-02-25" })] };
    const user = userEvent.setup();
    render(<WorkPermitAlertsSection />);
    await user.click(await screen.findByRole("button", { name: "Renewed" }));

    const dateInput = screen.getByLabelText(/New expiry date/);
    await user.type(dateInput, "2027-02-25"); // same date, not later
    await user.click(screen.getByRole("button", { name: "Save renewal" }));

    expect(await screen.findByText(/must be later than the current expiry date/)).toBeInTheDocument();
    expect(postCalls.length).toBe(0);
  });

  it("Renewed submits a valid later date, disables its Save button while processing", async () => {
    alertsResponse = { alerts: [makeAlert({ expiryDate: "2027-02-25" })] };
    const user = userEvent.setup();
    render(<WorkPermitAlertsSection />);
    await user.click(await screen.findByRole("button", { name: "Renewed" }));

    await user.type(screen.getByLabelText(/New expiry date/), "2028-02-25");
    const saveButton = screen.getByRole("button", { name: "Save renewal" });
    await user.click(saveButton);

    expect(postCalls.length).toBe(1);
    expect(postCalls[0].path).toBe("/api/employees/emp-1/renew");
    expect(postCalls[0].body).toEqual({ newExpiryDate: "2028-02-25" });
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();

    await act(async () => {
      postCalls[0].deferred.resolve({});
    });
  });

  it("Cancel alert asks for confirmation with an optional reason before calling the API", async () => {
    alertsResponse = { alerts: [makeAlert()] };
    const user = userEvent.setup();
    render(<WorkPermitAlertsSection />);
    await user.click(await screen.findByRole("button", { name: "Cancel alert" }));

    expect(screen.getByText(/This cancels the alert/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Reason \(optional\)/), "Already renewed via HR");
    // Two buttons share the label "Cancel alert" — the card's own trigger
    // and the modal's confirm action — the confirm one is the second/last.
    const cancelAlertButtons = screen.getAllByRole("button", { name: "Cancel alert" });
    await user.click(cancelAlertButtons[cancelAlertButtons.length - 1]);

    expect(postCalls.length).toBe(1);
    expect(postCalls[0].path).toBe("/api/employees/emp-1/cancel-alert");
    expect(postCalls[0].body).toEqual({ reason: "Already renewed via HR" });

    await act(async () => {
      postCalls[0].deferred.resolve({});
    });
  });

  it("sorts alerts soonest-expiry-first as returned by the server (renders in the given order)", async () => {
    alertsResponse = {
      alerts: [
        makeAlert({ employeeId: "soon", employeeName: "Soon Expiry", remainingDays: 5, severity: "red" }),
        makeAlert({ employeeId: "later", employeeName: "Later Expiry", remainingDays: 200, severity: "amber" }),
      ],
    };
    render(<WorkPermitAlertsSection />);
    await screen.findByText(/Soon Expiry/);
    const names = [...document.querySelectorAll(".work-permit-alert-detail")].map((el) => el.textContent);
    expect(names[0]).toContain("Soon Expiry");
    expect(names[1]).toContain("Later Expiry");
  });
});
