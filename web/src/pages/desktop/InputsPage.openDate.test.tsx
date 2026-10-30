// @vitest-environment jsdom
//
// Which day Inputs opens on. It used to keep the viewed day in ?date=, and
// the auto-selected employee wrote today's date there on every first visit
// — so the next morning a reload, a restored browser tab or the page left
// behind the login screen reopened Inputs on yesterday. Every fresh open
// must now start on today in the organization's time zone (America/Toronto,
// lib/timezone.ts), and a day chosen while working must stay put until
// Inputs is opened afresh.
//
// Renders the real App (login gate, sidebar, routes) with lib/api.ts mocked,
// and fakes only Date so the clock can be put anywhere — late evening in
// Toronto when UTC is already tomorrow, either side of midnight, and both
// daylight-saving changes.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { api } from "../../lib/api";
import { DailyInputsResponse } from "../../lib/inputsTypes";

let signedIn = true;

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  const me = { id: "emp-a", firstName: "Alice", lastName: "Anderson", securityRole: "Administrator", teamRole: "Team Member" };
  return {
    ApiError,
    onSessionExpired: vi.fn(() => () => {}),
    api: vi.fn((path: string) => {
      if (path === "/api/auth/me") {
        return signedIn ? Promise.resolve({ employee: me }) : Promise.reject(new ApiError(401, "Not authenticated"));
      }
      if (path === "/api/auth/login") {
        signedIn = true;
        return Promise.resolve({ employee: me });
      }
      if (path.startsWith("/api/inputs/employees")) {
        return Promise.resolve({
          employees: [
            { id: "emp-a", firstName: "Alice", lastName: "Anderson", photoUrl: null, paidSeconds: 0 },
            { id: "emp-b", firstName: "Beatriz", lastName: "Barrios", photoUrl: null, paidSeconds: 0 },
          ],
        });
      }
      if (path.startsWith("/api/inputs/daily")) {
        const url = new URL(path, "http://t");
        return Promise.resolve(emptyDay(url.searchParams.get("employeeId")!, url.searchParams.get("date")!));
      }
      if (path.startsWith("/api/row-completions/review-groups")) {
        return Promise.resolve({ date: new URL(path, "http://t").searchParams.get("date"), groups: [] });
      }
      // Other pages reached through the sidebar just stay loading.
      return new Promise(() => {});
    }),
  };
});

function emptyDay(employeeId: string, date: string): DailyInputsResponse {
  return {
    employee: { id: employeeId, firstName: employeeId === "emp-a" ? "Alice" : "Beatriz", lastName: "X", photoUrl: null },
    date,
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

function dailyCalls(): { employeeId: string; date: string }[] {
  return vi
    .mocked(api)
    .mock.calls.map(([p]) => p as string)
    .filter((p) => p.startsWith("/api/inputs/daily"))
    .map((p) => {
      const url = new URL(p, "http://t");
      return { employeeId: url.searchParams.get("employeeId")!, date: url.searchParams.get("date")! };
    });
}
const lastDaily = () => dailyCalls().slice(-1)[0];

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function setClock(iso: string) {
  vi.setSystemTime(new Date(iso));
}

// One app launch / page load at `path`.
function launch(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <LocationProbe />
    </MemoryRouter>
  );
}

async function expectOpenOn(date: string, employeeId = "emp-a") {
  await waitFor(() => expect(lastDaily()).toEqual({ employeeId, date }));
  expect(screen.getByTestId("location")).not.toHaveTextContent("date=");
}

beforeEach(() => {
  signedIn = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock("2026-10-30T16:00:00.000Z"); // Friday Oct 30, noon in Toronto
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }))
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Inputs opens on today", () => {
  it("app launch or reload of an old dated URL opens today, keeps the employee and drops the stale date", async () => {
    launch("/inputs?date=2026-10-20&employee=emp-b");
    await expectOpenOn("2026-10-30", "emp-b");
    expect(screen.getByTestId("location")).toHaveTextContent("/inputs?employee=emp-b");
    expect(dailyCalls().some((c) => c.date === "2026-10-20")).toBe(false);
  });

  it("the first visit never writes the date into the URL, so the next morning's reload opens the new day", async () => {
    setClock("2026-10-29T20:00:00.000Z"); // Thursday afternoon
    const day1 = launch("/inputs");
    await expectOpenOn("2026-10-29");
    const urlLeftOpen = screen.getByTestId("location").textContent!;
    day1.unmount();

    setClock("2026-10-30T11:30:00.000Z"); // Friday 7:30 am, reload the same URL
    launch(urlLeftOpen);
    await expectOpenOn("2026-10-30");
  });

  it("signing in again after being signed out lands on today, not the date left in the URL", async () => {
    signedIn = false;
    const user = userEvent.setup();
    launch("/inputs?date=2026-10-20&employee=emp-a");
    await user.type(await screen.findByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("PIN"), "1234");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await expectOpenOn("2026-10-30");
    expect(dailyCalls().some((c) => c.date === "2026-10-20")).toBe(false);
  });

  // [instant, Toronto wall clock, expected Inputs date]
  it.each([
    ["2026-10-31T02:30:00.000Z", "Fri Oct 30 22:30 EDT — UTC is already Oct 31", "2026-10-30"],
    ["2026-10-31T03:59:59.000Z", "Fri Oct 30 23:59:59 EDT — just before midnight", "2026-10-30"],
    ["2026-10-31T04:00:00.000Z", "Sat Oct 31 00:00 EDT — just after midnight", "2026-10-31"],
    ["2026-03-08T04:59:59.000Z", "Sat Mar 7 23:59:59 EST — night before spring-forward", "2026-03-07"],
    ["2026-03-08T05:00:00.000Z", "Sun Mar 8 00:00 EST — spring-forward day", "2026-03-08"],
    ["2026-03-09T03:59:59.000Z", "Sun Mar 8 23:59:59 EDT — end of the 23-hour day", "2026-03-08"],
    ["2026-03-09T04:00:00.000Z", "Mon Mar 9 00:00 EDT", "2026-03-09"],
    ["2026-11-01T03:59:59.000Z", "Sat Oct 31 23:59:59 EDT — night before fall-back", "2026-10-31"],
    ["2026-11-01T04:00:00.000Z", "Sun Nov 1 00:00 EDT — fall-back day", "2026-11-01"],
    ["2026-11-02T04:59:59.000Z", "Sun Nov 1 23:59:59 EST — end of the 25-hour day", "2026-11-01"],
    ["2026-11-02T05:00:00.000Z", "Mon Nov 2 00:00 EST", "2026-11-02"],
  ])("at %s (%s) opens %s", async (instant, _wallClock, expected) => {
    setClock(instant);
    launch("/inputs");
    await expectOpenOn(expected);
  });
});

describe("a day chosen while working stays put", () => {
  it("survives switching employees, background refreshes and the clock passing midnight", async () => {
    const user = userEvent.setup();
    launch("/inputs");
    await expectOpenOn("2026-10-30");

    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: "Previous day" }));
    await expectOpenOn("2026-10-27");

    await user.click(screen.getByRole("button", { name: /Beatriz Barrios/ }));
    await expectOpenOn("2026-10-27", "emp-b");

    // Midnight passes in Toronto while the page is open, then the table
    // refreshes (tab focus / reconnect, as after editing or adding work).
    setClock("2026-10-31T04:30:00.000Z");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(dailyCalls().filter((c) => c.date === "2026-10-27").length).toBeGreaterThan(2));
    expect(dailyCalls().some((c) => c.date === "2026-10-31")).toBe(false);
    expect(lastDaily()).toEqual({ employeeId: "emp-b", date: "2026-10-27" });
  });

  it("leaving Inputs and opening it again from the sidebar starts at today", async () => {
    const user = userEvent.setup();
    launch("/inputs");
    await expectOpenOn("2026-10-30");
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await expectOpenOn("2026-10-29");

    await user.click(screen.getByRole("link", { name: "Devices" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/devices"));
    await user.click(screen.getByRole("link", { name: "Inputs" }));
    await expectOpenOn("2026-10-30");
  });

  it("clicking Inputs in the sidebar while already on Inputs starts at today", async () => {
    const user = userEvent.setup();
    launch("/inputs");
    await expectOpenOn("2026-10-30");
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await expectOpenOn("2026-10-28");

    await user.click(screen.getByRole("link", { name: "Inputs" }));
    await expectOpenOn("2026-10-30");
  });
});
