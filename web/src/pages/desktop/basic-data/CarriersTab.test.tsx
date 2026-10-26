// @vitest-environment jsdom
//
// Basic Data > Carriers RFID tag support (065_carrier_rfid_tag.sql): the RFID
// Tag column sits right after Name, empty tags read "Not assigned", assigned
// tags show in full (leading zeros intact), search covers tags, and the
// existing Edit Carrier modal can assign, replace (confirmed) and clear
// (confirmed) a tag, surfacing the server's duplicate-tag 409 inline.
// lib/api.ts is mocked so every network call is fully controlled by the
// test — same convention as EmployeesPage.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarriersTab } from "./CarriersTab";
import { AuthProvider } from "../../../context/AuthContext";
import { api, ApiError } from "../../../lib/api";
import { Carrier } from "../../../lib/carrierTypes";

let meRole: string;
let carriersResponse: { carriers: Carrier[] };
let patchResult: (body: Record<string, unknown>) => Promise<unknown>;

vi.mock("../../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    errors?: Record<string, string>;
    constructor(status: number, message: string, errors?: Record<string, string>) {
      super(message);
      this.status = status;
      this.errors = errors;
    }
  }
  return {
    ApiError,
    onSessionExpired: vi.fn(() => () => {}),
    api: vi.fn((path: string, init?: { method?: string; body?: string }) => {
      if (path.startsWith("/api/auth/me")) {
        return Promise.resolve({ employee: { id: "u-1", firstName: "Ada", lastName: "Admin", securityRole: meRole, teamRole: "Team Member" } });
      }
      if (path.startsWith("/api/carriers/") && init?.method === "PATCH") return patchResult(JSON.parse(init.body ?? "{}"));
      if (path.startsWith("/api/carriers")) return Promise.resolve(carriersResponse);
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

const apiMock = vi.mocked(api);

function makeCarrier(overrides: Partial<Carrier> = {}): Carrier {
  return {
    id: "c-1",
    name: "Bin 1",
    notes: null,
    tareWeightKg: 27.5,
    rfidTag: null,
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderTab() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <CarriersTab />
      </AuthProvider>
    </MemoryRouter>
  );
}

function patchCalls() {
  return apiMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === "PATCH");
}

beforeEach(() => {
  meRole = "Administrator";
  carriersResponse = {
    carriers: [makeCarrier(), makeCarrier({ id: "c-2", name: "Bin 2", rfidTag: "0000000182225750", tareWeightKg: 30 })],
  };
  patchResult = () => Promise.resolve({ carrier: makeCarrier() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CarriersTab RFID tags", () => {
  it("puts the RFID Tag column immediately after Name, keeping the other columns", async () => {
    renderTab();
    await screen.findAllByText("Bin 2");
    const headers = within(document.querySelector(".employees-table")!).getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["Name", "RFID Tag", "Tare weight", "Notes", "Status", ""]);
  });

  it("shows 'Not assigned' for an empty tag and the full identifier, leading zeros intact, when assigned", async () => {
    renderTab();
    await screen.findAllByText("Bin 2");
    const rows = within(document.querySelector(".employees-table tbody")!).getAllByRole("row");
    expect(within(rows[0]).getAllByRole("cell")[1]).toHaveTextContent(/^Not assigned$/);
    expect(within(rows[1]).getAllByRole("cell")[1]).toHaveTextContent(/^0000000182225750$/);
  });

  it("sends the search box to the server, which matches carrier name or RFID tag", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findAllByText("Bin 2");
    await user.type(screen.getByPlaceholderText("Search by carrier name or RFID tag"), "182225750");
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([path]) => String(path).includes("search=182225750"))).toBe(true)
    );
  });

  it("lets an admin assign a tag through the existing Edit modal", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findAllByText("Bin 2");
    const row = within(document.querySelector(".employees-table tbody")!).getAllByRole("row")[0];
    await user.click(await within(row).findByRole("button", { name: "Edit" }));

    await user.type(screen.getByLabelText("RFID tag"), " 0000000182225751 ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    const body = JSON.parse((patchCalls()[0][1] as { body: string }).body);
    expect(body.rfidTag).toBe("0000000182225751");
    expect(body.tareWeightKg).toBe(27.5);
  });

  it("shows the server's duplicate-tag error inline and keeps the modal open", async () => {
    const user = userEvent.setup();
    patchResult = () =>
      Promise.reject(new (ApiError as unknown as new (s: number, m: string, e: Record<string, string>) => Error)(409, "Conflict", {
        rfidTag: 'RFID tag 0000000182225750 is already assigned to "Bin 2". Clear it there first.',
      }));
    renderTab();
    await screen.findAllByText("Bin 2");
    const row = within(document.querySelector(".employees-table tbody")!).getAllByRole("row")[0];
    await user.click(await within(row).findByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("RFID tag"), "0000000182225750");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/already assigned to "Bin 2"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("asks before clearing an existing tag, and sends null once confirmed", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderTab();
    await screen.findAllByText("Bin 2");
    const row = within(document.querySelector(".employees-table tbody")!).getAllByRole("row")[1];
    await user.click(await within(row).findByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("RFID tag");
    expect(input).toHaveValue("0000000182225750");

    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/Remove RFID tag 0000000182225750 from "Bin 2"/);
    expect(patchCalls()).toHaveLength(0); // declined: nothing saved

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(JSON.parse((patchCalls()[0][1] as { body: string }).body).rfidTag).toBeNull();
  });

  it("asks before replacing an existing tag", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderTab();
    await screen.findAllByText("Bin 2");
    const row = within(document.querySelector(".employees-table tbody")!).getAllByRole("row")[1];
    await user.click(await within(row).findByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("RFID tag");
    await user.clear(input);
    await user.type(input, "0000000999999999");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(confirmSpy.mock.calls[0][0]).toMatch(/Replace RFID tag 0000000182225750 on "Bin 2" with 0000000999999999/);
    expect(patchCalls()).toHaveLength(0);
  });

  it("does not ask when an existing tag is saved unchanged", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    renderTab();
    await screen.findAllByText("Bin 2");
    const row = within(document.querySelector(".employees-table tbody")!).getAllByRole("row")[1];
    await user.click(await within(row).findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(JSON.parse((patchCalls()[0][1] as { body: string }).body).rfidTag).toBe("0000000182225750");
  });

  it("gives non-admins no Edit button, so tags are view-only for Managers", async () => {
    meRole = "Manager";
    renderTab();
    await screen.findAllByText("Bin 2");
    // Let the signed-in role resolve before asserting the Edit button's absence.
    const meCall = apiMock.mock.results[apiMock.mock.calls.findIndex(([path]) => String(path).startsWith("/api/auth/me"))];
    await meCall?.value;
    expect(screen.getAllByText("0000000182225750").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });
});
