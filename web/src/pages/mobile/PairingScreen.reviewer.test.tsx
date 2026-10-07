// @vitest-environment jsdom
// Reviewer access on the pairing screen: offered in the native app next to
// the normal 6-digit code (which keeps working unchanged), and a phone that
// is already on the demo instance never shows a normal pairing code.
import "fake-indexeddb/auto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const markPaired = vi.fn();
let native = true;

vi.mock("../../context/DevicePairingContext", () => ({
  useDevicePairing: () => ({ markPaired }),
}));
vi.mock("../../lib/platform", () => ({
  isNativePlatform: () => native,
}));

import { REVIEWER_API_URL_KEY } from "../../lib/device";
import { PairingScreen } from "./PairingScreen";

const DEMO = "https://demo-api.example.test";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  markPaired.mockReset();
  native = true;
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/api/pairing/request")) {
      return jsonResponse(200, { requestId: "r1", pairingCode: "123456", expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (url.endsWith("/api/pairing/reviewer-target")) return jsonResponse(200, { apiUrl: DEMO });
    if (url === `${DEMO}/api/pairing/reviewer`) {
      return jsonResponse(200, { paired: true, employee: { firstName: "Demo", lastName: "Reviewer 1" } });
    }
    return jsonResponse(200, { status: "pending" });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PairingScreen reviewer access", () => {
  it("still shows the normal pairing code, and offers an access code in the native app", async () => {
    render(<PairingScreen />);
    expect(await screen.findByText("123456")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Have an access code?" })).toBeTruthy();
  });

  it("does not offer access codes in a normal browser", async () => {
    native = false;
    render(<PairingScreen />);
    expect(await screen.findByText("123456")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Have an access code?" })).toBeNull();
  });

  it("pairs with a valid code and switches the phone to the demo API", async () => {
    const user = userEvent.setup();
    render(<PairingScreen />);
    await user.click(await screen.findByRole("button", { name: "Have an access code?" }));
    await user.type(screen.getByLabelText("Access code"), "DEMO-ABCD-EFGH-JKMN");
    await user.click(screen.getByRole("button", { name: "Use access code" }));
    await waitFor(() => expect(markPaired).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(REVIEWER_API_URL_KEY)).toBe(DEMO);
  });

  it("shows a plain error for a wrong code and stays unpaired", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/pairing/request")) {
        return jsonResponse(200, { requestId: "r1", pairingCode: "123456", expiresAt: new Date(Date.now() + 600000).toISOString() });
      }
      if (url.endsWith("/api/pairing/reviewer-target")) return jsonResponse(200, { apiUrl: DEMO });
      if (url === `${DEMO}/api/pairing/reviewer`) {
        return jsonResponse(401, { error: "That access code is not valid.", code: "INVALID_REVIEWER_CODE" });
      }
      return jsonResponse(200, { status: "pending" });
    });
    const user = userEvent.setup();
    render(<PairingScreen />);
    await user.click(await screen.findByRole("button", { name: "Have an access code?" }));
    await user.type(screen.getByLabelText("Access code"), "nope");
    await user.click(screen.getByRole("button", { name: "Use access code" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not valid");
    expect(markPaired).not.toHaveBeenCalled();
    expect(localStorage.getItem(REVIEWER_API_URL_KEY)).toBeNull();
  });

  it("on a phone already switched to the demo instance, requests no normal pairing code", async () => {
    localStorage.setItem(REVIEWER_API_URL_KEY, DEMO);
    render(<PairingScreen />);
    expect(await screen.findByText(/set up for the LabourLink demo/)).toBeTruthy();
    expect(screen.getByLabelText("Access code")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/pairing/request"))).toBe(false);
  });
});
