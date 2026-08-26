// A weak-signal connection can leave a bare fetch() hanging indefinitely —
// see the mobile offline investigation this fixes. Proves api()'s
// AbortController bound actually fires, that the resulting rejection is
// classified as an ordinary "network problem" (never data loss — the same
// treatment offlineQueue.ts already gives any other TypeError), and that a
// response arriving before the bound is completely unaffected.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiTimeoutError, isServerUnreachableError } from "./api";
import { isNetworkError } from "./offlineQueue";

const originalFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

// A fetch mock that never settles on its own — only rejects once the
// AbortController's signal actually fires, exactly like a real weak-signal
// connection that never gets a response OR a clean refusal.
function neverSettlingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  });
}

describe("api() request timeout", () => {
  it("aborts a request that never resolves, after the default 15s bound, as a classified network error — not a hang", async () => {
    vi.useFakeTimers();
    global.fetch = neverSettlingFetch() as unknown as typeof fetch;

    const promise = api("/api/mobile/me");
    let error: unknown;
    let settled = false;
    promise.catch((e) => {
      error = e;
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(14999);
    expect(settled).toBe(false); // hasn't given up yet — a healthy-but-slow call could still land

    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    expect(error).toBeInstanceOf(ApiTimeoutError);
    // The whole point: an intentional timeout must be treated exactly like
    // any other "server unreachable" condition — safe to retry, never
    // mistaken for data loss or a permanent rejection.
    expect(isNetworkError(error)).toBe(true);
    expect(isServerUnreachableError(error)).toBe(true);
  });

  it("a custom timeoutMs overrides the default for one call", async () => {
    vi.useFakeTimers();
    global.fetch = neverSettlingFetch() as unknown as typeof fetch;

    const promise = api("/api/mobile/slow-endpoint", { timeoutMs: 2000 });
    let settled = false;
    promise.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
  });

  it("a response that arrives well before the timeout is completely unaffected", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hello: "world" }),
    }) as unknown as typeof fetch;

    const result = await api<{ hello: string }>("/api/mobile/me");
    expect(result).toEqual({ hello: "world" });
  });

  it("a 5-second-delayed-but-successful response still resolves normally (not misclassified as a timeout)", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ ok: true, status: 200, json: async () => ({ delayed: true }) }),
          5000
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const promise = api<{ delayed: boolean }>("/api/mobile/me");
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result).toEqual({ delayed: true });
  });
});
