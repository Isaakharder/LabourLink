// RFID registration flow against a mocked local service: the station only
// forwards to the LabourLink server's own login + PATCH /api/carriers/:id,
// so these tests check the workflow (scan → choose → confirm → save) and that
// server errors (wrong role, duplicate tag) reach the admin unchanged.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RfidRegistration } from "./RfidRegistration";
import { makeSnapshot } from "../testFixtures";

const calls: { path: string; body?: unknown; adminToken?: string }[] = [];
let rfidResult: () => Promise<unknown>;
let loginResult: () => Promise<unknown>;

vi.mock("../api", () => {
  class ServiceError extends Error {
    status: number;
    errors: Record<string, string>;
    constructor(status: number, message: string, errors: Record<string, string> = {}) {
      super(message);
      this.status = status;
      this.errors = errors;
    }
  }
  return {
    ServiceError,
    call: vi.fn((path: string, init: { body?: unknown; adminToken?: string } = {}) => {
      calls.push({ path, ...init });
      if (path === "/api/admin/login") return loginResult();
      if (path === "/api/rfid/last") return Promise.resolve({ tag: "0000000182225799", secondsAgo: 2, carrierId: null, carrierName: null });
      if (path.startsWith("/api/admin/carriers")) {
        return Promise.resolve({
          carriers: [
            { id: "c-13", name: "Sim Bin 13", rfidTag: null, tareWeightKg: 27.2, isActive: true },
            { id: "c-01", name: "Sim Bin 1", rfidTag: "0000000182225750", tareWeightKg: 27.5, isActive: true },
          ],
        });
      }
      if (path === "/api/admin/rfid") return rfidResult();
      if (path === "/api/admin/logout") return Promise.resolve({ ok: true });
      return Promise.reject(new Error(`unexpected ${path}`));
    }),
  };
});

import { ServiceError } from "../api";

beforeEach(() => {
  calls.length = 0;
  loginResult = () => Promise.resolve({ token: "tok-1", name: "Sim Admin" });
  rfidResult = () => Promise.resolve({ carrier: { id: "c-13", name: "Sim Bin 13", rfidTag: "0000000182225799", tareWeightKg: 27.2, isActive: true } });
});

afterEach(() => {
  cleanup();
});

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  render(<RfidRegistration s={makeSnapshot()} onDone={() => {}} />);
  await user.type(screen.getByLabelText("Email"), "admin@sim.local");
  await user.type(screen.getByLabelText("PIN"), "1234");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText(/Signed in as Sim Admin/);
}

describe("RfidRegistration", () => {
  it("shows the server's refusal for a non-administrator", async () => {
    const user = userEvent.setup();
    loginResult = () => Promise.reject(new ServiceError(403, "Sim Manager is a Manager. Only LabourLink Administrators can register RFID tags."));
    render(<RfidRegistration s={makeSnapshot()} onDone={() => {}} />);
    await user.type(screen.getByLabelText("Email"), "manager@sim.local");
    await user.type(screen.getByLabelText("PIN"), "1234");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only LabourLink Administrators");
  });

  it("links a freshly scanned tag to an unassigned bin", async () => {
    const user = userEvent.setup();
    await signIn(user);
    await user.click(await screen.findByRole("button", { name: "Use this tag" }));
    await user.click(await screen.findByRole("button", { name: /Sim Bin 13/ }));
    await user.click(screen.getByRole("button", { name: "Link tag to Sim Bin 13" }));
    expect(await screen.findByText("Tag 0000000182225799 is now linked to Sim Bin 13.")).toBeInTheDocument();
    const save = calls.find((c) => c.path === "/api/admin/rfid")!;
    expect(save.body).toEqual({ carrierId: "c-13", rfidTag: "0000000182225799" });
    expect(save.adminToken).toBe("tok-1");
  });

  it("asks before replacing a bin's existing tag", async () => {
    const user = userEvent.setup();
    await signIn(user);
    await user.click(await screen.findByRole("button", { name: "Use this tag" }));
    await user.click(await screen.findByRole("button", { name: /Sim Bin 1\b/ }));
    await user.click(screen.getByRole("button", { name: "Link tag to Sim Bin 1" }));
    expect(screen.getByText(/Replace tag/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/admin/rfid")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/admin/rfid")).toBe(true));
  });

  it("surfaces the server's duplicate-tag error", async () => {
    const user = userEvent.setup();
    rfidResult = () => Promise.reject(new ServiceError(409, 'RFID tag 0000000182225799 is already assigned to "Sim Bin 4". Clear it there first.'));
    await signIn(user);
    await user.click(await screen.findByRole("button", { name: "Use this tag" }));
    await user.click(await screen.findByRole("button", { name: /Sim Bin 13/ }));
    await user.click(screen.getByRole("button", { name: "Link tag to Sim Bin 13" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('already assigned to "Sim Bin 4"');
  });

  it("requires confirmation to remove a tag and sends null", async () => {
    const user = userEvent.setup();
    rfidResult = () => Promise.resolve({ carrier: { id: "c-01", name: "Sim Bin 1", rfidTag: null, tareWeightKg: 27.5, isActive: true } });
    await signIn(user);
    await user.click(await screen.findByRole("button", { name: /Sim Bin 1\b/ }));
    await user.click(screen.getByRole("button", { name: "Remove tag" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/admin/rfid")?.body).toEqual({ carrierId: "c-01", rfidTag: null }));
  });
});
