// @vitest-environment jsdom
//
// Register Bins against a mocked local service: any user signs in, the
// screen follows the service's measurement (clear the scale, measure, the
// proposed tag and tare), the person enters the bin number, sees overwrite
// and tag-on-another-bin warnings that must be ticked, confirms the bin is
// empty, and the confirm request carries exactly what they saw. Refusals
// from the server reach the person unchanged.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterBins } from "./RegisterBins";
import { makeSnapshot } from "../testFixtures";
import type { RegBin, RegistrationView, Snapshot } from "../types";

const calls: { path: string; body?: unknown; sessionToken?: string }[] = [];
let bins: RegBin[] = [];
let tagOwner: RegBin | null = null;
let confirmResult: () => Promise<unknown> = () => Promise.resolve({});

vi.mock("../api", () => {
  class ServiceError extends Error {
    status: number;
    errors: Record<string, string>;
    code: string | null;
    data: Record<string, unknown>;
    constructor(status: number, message: string, errors: Record<string, string> = {}, code: string | null = null, data: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.errors = errors;
      this.code = code;
      this.data = data;
    }
  }
  return {
    ServiceError,
    call: vi.fn((path: string, init: { body?: unknown; sessionToken?: string } = {}) => {
      calls.push({ path, ...init });
      if (path === "/api/session/login") return Promise.resolve({ token: "t-1", name: "Pia Picker" });
      if (path.startsWith("/api/register/bins")) return Promise.resolve({ bins });
      if (path === "/api/register/tag-owner") return Promise.resolve({ tag: "0000000182225750", bin: tagOwner });
      if (path === "/api/register/confirm") return confirmResult();
      return Promise.resolve({ ok: true });
    }),
  };
});

const { ServiceError } = (await import("../api")) as unknown as { ServiceError: new (...a: unknown[]) => Error };

const BIN77: RegBin = { id: "c-77", name: "Bin 77", rfidTag: null, tareWeightKg: 0, isActive: true };

function reg(phase: RegistrationView["phase"], weightG = 154_400): RegistrationView {
  return {
    person: "Pia Picker",
    phase,
    reading: { weightG, mode: "gross", motion: false, overload: false, underload: false, error: false },
    scaleOnline: true,
    settleRemainingMs: 0,
    clearRemainingMs: 0,
  };
}

const PROPOSED = reg({ phase: "proposed", proposal: { id: "p-1", tag: "0000000182225750", grossG: 154_400, samplesG: [154_400], stableMs: 2000 } });

function snap(registration: RegistrationView | null): Snapshot {
  return makeSnapshot({ registration });
}

async function signIn(user: ReturnType<typeof userEvent.setup>, rerender: (ui: React.ReactElement) => void, next: RegistrationView) {
  await user.type(screen.getByLabelText("Email"), "pia@greenhouse.test");
  await user.type(screen.getByLabelText("PIN"), "1234");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(calls.some((c) => c.path === "/api/register/start")).toBe(true));
  rerender(<RegisterBins s={snap(next)} onDone={() => {}} />);
}

beforeEach(() => {
  calls.length = 0;
  bins = [BIN77];
  tagOwner = null;
  confirmResult = () => Promise.resolve({ carrier: { ...BIN77, rfidTag: "0000000182225750", tareWeightKg: 154.4 } });
});
afterEach(cleanup);

describe("RegisterBins", () => {
  it("lets any user sign in, then opens Register Bins on the service (weighing pauses)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RegisterBins s={snap(null)} onDone={() => {}} />);
    expect(screen.getByText(/Weighing pauses while Register Bins is open/)).toBeInTheDocument();
    await signIn(user, rerender, reg({ phase: "clearScale", emptySinceMs: null }, 172_500));
    expect(calls.find((c) => c.path === "/api/register/start")?.sessionToken).toBe("t-1");
    expect(screen.getByText("Clear the scale")).toBeInTheDocument();
    expect(screen.getByText(/Signed in as Pia Picker · weighing is paused/)).toBeInTheDocument();
  });

  it("shows the measured tag and proposed tare, and registers only after the bin number and 'completely empty' are confirmed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RegisterBins s={snap(null)} onDone={() => {}} />);
    await signIn(user, rerender, PROPOSED);
    expect(screen.getAllByText("0000000182225750").length).toBeGreaterThan(0);
    expect(screen.getByText("Proposed tare").nextElementSibling).toHaveTextContent("154.40 kg");
    // On-screen keypad
    await user.click(screen.getByRole("button", { name: "7" }));
    await user.click(screen.getByRole("button", { name: "7" }));
    expect(screen.getByLabelText("Bin number")).toHaveValue("77");
    await user.click(await screen.findByRole("button", { name: /Bin 77/ }));
    const register = screen.getByRole("button", { name: "Register Bin 77" });
    expect(register).toBeDisabled();
    await user.click(screen.getByLabelText("This bin is completely empty"));
    expect(register).toBeEnabled();
    await user.click(register);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/register/confirm")).toBe(true));
    expect(calls.find((c) => c.path === "/api/register/confirm")?.body).toEqual({
      carrierId: "c-77",
      expected: { rfidTag: null, tareWeightKg: 0 },
      emptyConfirmed: true,
      confirmOverwrite: false,
      moveFromCarrierId: null,
    });
  });

  it("warns before replacing a bin's tag or tare, and before moving a tag registered to another bin", async () => {
    bins = [{ id: "c-77", name: "Bin 77", rfidTag: "0000000000000077", tareWeightKg: 150, isActive: true }];
    tagOwner = { id: "c-3", name: "Bin 3", rfidTag: "0000000182225750", tareWeightKg: 154.4, isActive: true };
    const user = userEvent.setup();
    const { rerender } = render(<RegisterBins s={snap(null)} onDone={() => {}} />);
    await signIn(user, rerender, PROPOSED);
    await user.type(screen.getByLabelText("Bin number"), "77");
    await user.click(await screen.findByRole("button", { name: /Bin 77/ }));
    await user.click(screen.getByLabelText("This bin is completely empty"));
    const register = screen.getByRole("button", { name: "Register Bin 77" });
    expect(register).toBeDisabled();
    await user.click(screen.getByLabelText(/Replace Bin 77's tag 0000000000000077 and tare 150.00 kg/));
    expect(register).toBeDisabled();
    await user.click(screen.getByLabelText(/This tag is registered to Bin 3/));
    expect(register).toBeEnabled();
    await user.click(register);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/register/confirm")).toBe(true));
    expect(calls.find((c) => c.path === "/api/register/confirm")?.body).toMatchObject({
      expected: { rfidTag: "0000000000000077", tareWeightKg: 150 },
      confirmOverwrite: true,
      moveFromCarrierId: "c-3",
    });
  });

  it("shows a server refusal and the bin's current values when it changed meanwhile", async () => {
    confirmResult = () =>
      Promise.reject(
        new ServiceError(409, "Bin 77 was changed while you were registering.", {}, "stale", {
          current: { id: "c-77", name: "Bin 77", rfidTag: "0000000000000099", tareWeightKg: 151, isActive: true },
        })
      );
    const user = userEvent.setup();
    const { rerender } = render(<RegisterBins s={snap(null)} onDone={() => {}} />);
    await signIn(user, rerender, PROPOSED);
    await user.type(screen.getByLabelText("Bin number"), "77");
    await user.click(await screen.findByRole("button", { name: /Bin 77/ }));
    await user.click(screen.getByLabelText("This bin is completely empty"));
    await user.click(screen.getByRole("button", { name: "Register Bin 77" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bin 77 was changed while you were registering.");
    expect(screen.getByText(/0000000000000099 · 151.00 kg/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Replace Bin 77's tag 0000000000000099/)).not.toBeChecked();
  });

  it("confirms success and asks for the bin to be removed before the next one", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RegisterBins s={snap(null)} onDone={() => {}} />);
    await signIn(user, rerender, reg({ phase: "saved", binName: "Bin 77", rfidTag: "0000000182225750", tareG: 154_400, emptySinceMs: null }));
    expect(screen.getByText("Bin 77 registered")).toBeInTheDocument();
    expect(screen.getByText(/The scale must return to zero before the next bin/)).toBeInTheDocument();
  });

  it("removes a tag from a bin as a correction, after explicit confirmation", async () => {
    bins = [{ id: "c-71", name: "Bin 71", rfidTag: "0000000182225750", tareWeightKg: 154.4, isActive: true }];
    const user = userEvent.setup();
    const { rerender } = render(<RegisterBins s={snap(null)} onDone={() => {}} />);
    await signIn(user, rerender, reg({ phase: "ready" }, 0));
    await user.click(screen.getByRole("button", { name: "Corrections" }));
    await user.type(screen.getByLabelText("Bin number"), "71");
    await user.click(await screen.findByRole("button", { name: /Bin 71/ }));
    const remove = screen.getByRole("button", { name: "Remove tag" });
    expect(remove).toBeDisabled();
    await user.click(screen.getByLabelText(/Remove tag 0000000182225750 from Bin 71/));
    await user.click(remove);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/register/remove-tag")).toBe(true));
    expect(calls.find((c) => c.path === "/api/register/remove-tag")?.body).toMatchObject({
      carrierId: "c-71",
      expected: { rfidTag: "0000000182225750", tareWeightKg: 154.4 },
      confirm: true,
    });
  });

  it("Done closes Register Bins and signs out", async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<RegisterBins s={snap(null)} onDone={onDone} />);
    await user.type(screen.getByLabelText("Email"), "pia@greenhouse.test");
    await user.type(screen.getByLabelText("PIN"), "1234");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/register/start")).toBe(true));
    rerender(<RegisterBins s={snap(reg({ phase: "ready" }, 0))} onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: /Done/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining(["/api/register/stop", "/api/session/logout"]));
  });
});
