// @vitest-environment jsdom
// App-store reviewer pairing: the code is redeemed against the DEMO API, and
// only a successful redemption switches this phone to that API — sticky, so
// a demo phone's queued events can never be sent to production.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeApiUrl, api, API_URL } from "./api";
import {
  getReviewerApiUrl,
  normalizeReviewerApiUrl,
  recoverDeviceIdentityFromBackup,
  REVIEWER_API_URL_KEY,
  DEVICE_ID_KEY,
} from "./device";
import { pairWithReviewerCode } from "./reviewerAccess";

const DEMO = "https://demo-api.example.test";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pairWithReviewerCode", () => {
  it("asks the normal API for the demo origin, redeems there, then routes every request to the demo API", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { apiUrl: DEMO }))
      .mockResolvedValueOnce(jsonResponse(200, { paired: true, employee: { firstName: "Demo", lastName: "Reviewer 1" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const employee = await pairWithReviewerCode("demo-abcd-efgh-jkmn");
    expect(employee).toEqual({ firstName: "Demo", lastName: "Reviewer 1" });

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_URL}/api/pairing/reviewer-target`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${DEMO}/api/pairing/reviewer`);
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sent.code).toBe("demo-abcd-efgh-jkmn");
    expect(typeof sent.deviceIdentifier).toBe("string");

    expect(getReviewerApiUrl()).toBe(DEMO);
    expect(activeApiUrl()).toBe(DEMO);
    await api("/api/mobile/me");
    expect(fetchMock.mock.calls[2][0]).toBe(`${DEMO}/api/mobile/me`);
  });

  it("leaves the phone on the normal API when the code is rejected", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { apiUrl: DEMO }))
      .mockResolvedValueOnce(jsonResponse(401, { error: "That access code is not valid.", code: "INVALID_REVIEWER_CODE" }));

    await expect(pairWithReviewerCode("wrong")).rejects.toMatchObject({ status: 401, code: "INVALID_REVIEWER_CODE" });
    expect(getReviewerApiUrl()).toBeNull();
    expect(activeApiUrl()).toBe(API_URL);
  });

  it("refuses a demo URL that isn't a bare https origin, without contacting it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { apiUrl: "http://demo-api.example.test" }));
    await expect(pairWithReviewerCode("DEMO-ABCD-EFGH-JKMN")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getReviewerApiUrl()).toBeNull();
  });

  it("does nothing when the normal API has no reviewer access configured", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "Reviewer access is not available", code: "REVIEWER_ACCESS_UNAVAILABLE" }));
    await expect(pairWithReviewerCode("DEMO-ABCD-EFGH-JKMN")).rejects.toMatchObject({ code: "REVIEWER_ACCESS_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getReviewerApiUrl()).toBeNull();
  });
});

describe("reviewer API target storage", () => {
  it("accepts only bare https origins", () => {
    expect(normalizeReviewerApiUrl("https://demo.example.test")).toBe("https://demo.example.test");
    expect(normalizeReviewerApiUrl("https://demo.example.test/")).toBe("https://demo.example.test");
    expect(normalizeReviewerApiUrl("http://demo.example.test")).toBeNull();
    expect(normalizeReviewerApiUrl("https://demo.example.test/api")).toBeNull();
    expect(normalizeReviewerApiUrl("https://user:pw@demo.example.test")).toBeNull();
    expect(normalizeReviewerApiUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeReviewerApiUrl(null)).toBeNull();
  });

  it("ignores a tampered stored value and falls back to the normal API", () => {
    localStorage.setItem(REVIEWER_API_URL_KEY, "http://evil.example.test");
    expect(getReviewerApiUrl()).toBeNull();
    expect(activeApiUrl()).toBe(API_URL);
  });

  it("is restored from the IndexedDB mirror if localStorage was evicted, so a demo phone stays on the demo API", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { apiUrl: DEMO }))
      .mockResolvedValueOnce(jsonResponse(200, { paired: true, employee: { firstName: "Demo", lastName: "Reviewer 2" } }));
    await pairWithReviewerCode("DEMO-ABCD-EFGH-JKMN");
    // setMirrored's IndexedDB write is fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 50));

    localStorage.clear();
    expect(activeApiUrl()).toBe(API_URL);
    await recoverDeviceIdentityFromBackup();
    expect(localStorage.getItem(DEVICE_ID_KEY)).not.toBeNull();
    expect(activeApiUrl()).toBe(DEMO);
  });
});
