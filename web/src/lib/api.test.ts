import { beforeAll, describe, expect, it } from "vitest";

// api.ts's module-level resolveApiUrl() reads `window.location` when running
// in Vite's dev mode (which vitest's default test mode also sets
// import.meta.env.DEV to) — stub just enough of `window` before the module
// is ever imported so that runs under plain Node, same reasoning as
// device.test.ts's fake localStorage.
let ApiError: typeof import("./api").ApiError;
let getPermanentDeviceAuthErrorCode: typeof import("./api").getPermanentDeviceAuthErrorCode;
let isPermanentDeviceAuthError: typeof import("./api").isPermanentDeviceAuthError;
let isServerUnreachableError: typeof import("./api").isServerUnreachableError;

beforeAll(async () => {
  (globalThis as { window?: unknown }).window ??= { location: { protocol: "http:", hostname: "localhost" } };
  const api = await import("./api");
  ApiError = api.ApiError;
  getPermanentDeviceAuthErrorCode = api.getPermanentDeviceAuthErrorCode;
  isPermanentDeviceAuthError = api.isPermanentDeviceAuthError;
  isServerUnreachableError = api.isServerUnreachableError;
});

describe("getPermanentDeviceAuthErrorCode / isPermanentDeviceAuthError", () => {
  it("recognizes every permanent device-auth code as permanent", () => {
    const codes = ["INVALID_DEVICE_IDENTIFIER", "DEVICE_NOT_FOUND", "DEVICE_INACTIVE", "DEVICE_UNASSIGNED", "EMPLOYEE_INACTIVE"];
    for (const code of codes) {
      const err = new ApiError(401, "rejected", undefined, code);
      expect(getPermanentDeviceAuthErrorCode(err)).toBe(code);
      expect(isPermanentDeviceAuthError(err)).toBe(true);
    }
  });

  it("treats a bare 401 with no code as transient, not permanent", () => {
    const err = new ApiError(401, "unauthorized");
    expect(getPermanentDeviceAuthErrorCode(err)).toBeNull();
    expect(isPermanentDeviceAuthError(err)).toBe(false);
  });

  it("treats an unrecognized code as transient rather than guessing", () => {
    const err = new ApiError(401, "rejected", undefined, "SOME_FUTURE_CODE");
    expect(getPermanentDeviceAuthErrorCode(err)).toBeNull();
  });

  it("never treats a 5xx as permanent even with a code-shaped body", () => {
    const err = new ApiError(500, "server error", undefined, "DEVICE_INACTIVE");
    expect(getPermanentDeviceAuthErrorCode(err)).toBeNull();
  });

  it("never treats a plain network failure as permanent", () => {
    const err = new TypeError("Failed to fetch");
    expect(getPermanentDeviceAuthErrorCode(err)).toBeNull();
    expect(isPermanentDeviceAuthError(err)).toBe(false);
  });
});

describe("isServerUnreachableError", () => {
  it("is true for a network-layer failure", () => {
    expect(isServerUnreachableError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("is true for any 5xx response", () => {
    expect(isServerUnreachableError(new ApiError(500, "server error"))).toBe(true);
    expect(isServerUnreachableError(new ApiError(503, "unavailable"))).toBe(true);
  });

  it("is false for a real 4xx rejection — the server was reached and answered", () => {
    expect(isServerUnreachableError(new ApiError(401, "rejected", undefined, "DEVICE_INACTIVE"))).toBe(false);
    expect(isServerUnreachableError(new ApiError(400, "bad request"))).toBe(false);
  });
});
