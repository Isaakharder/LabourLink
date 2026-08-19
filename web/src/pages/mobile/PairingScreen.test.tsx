// @vitest-environment jsdom
// Real production incident: every affected phone showed the exact same
// generic "Could not start pairing" message, with a bare `catch {}`
// swallowing whatever actually happened — no way to tell a 404 (route not
// deployed) from a 500 (server/migration problem) from a 401/403 (auth
// regression) from a request that never reached the server at all. This
// proves diagnosticCodeFor correctly distinguishes each case.
import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { diagnosticCodeFor } from "./PairingScreen";

describe("diagnosticCodeFor", () => {
  it("reports a 404 as a distinct code (route not deployed / wrong path)", () => {
    expect(diagnosticCodeFor(new ApiError(404, "Not found"))).toBe("HTTP 404");
  });

  it("reports a 500 as a distinct code (missing migration/config)", () => {
    expect(diagnosticCodeFor(new ApiError(500, "Internal server error"))).toBe("HTTP 500");
  });

  it("includes the machine-readable code when the server provided one (e.g. an auth regression)", () => {
    expect(diagnosticCodeFor(new ApiError(403, "Forbidden", undefined, "PAIRING_DISABLED"))).toBe(
      "HTTP 403 (PAIRING_DISABLED)"
    );
  });

  it("reports a raw fetch failure (DNS/TLS/no network) as NETWORK_ERROR, distinct from any HTTP status", () => {
    const code = diagnosticCodeFor(new TypeError("Failed to fetch"));
    expect(code).toContain("NETWORK_ERROR");
    expect(code).not.toContain("HTTP");
  });

  it("falls back to the raw error message for anything unexpected, rather than silently saying nothing", () => {
    expect(diagnosticCodeFor(new Error("something truly unexpected"))).toBe(
      "UNKNOWN_ERROR (something truly unexpected)"
    );
  });
});
