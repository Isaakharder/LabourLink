import { describe, expect, it } from "vitest";
import { singleFlight } from "./singleFlight";

describe("singleFlight", () => {
  it("calls the underlying function once for overlapping calls", async () => {
    let calls = 0;
    const wrapped = singleFlight(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "result";
    });

    const [a, b, c] = await Promise.all([wrapped(), wrapped(), wrapped()]);

    expect(calls).toBe(1);
    expect(a).toBe("result");
    expect(b).toBe("result");
    expect(c).toBe("result");
  });

  it("allows a fresh call once the prior one has settled", async () => {
    let calls = 0;
    const wrapped = singleFlight(async () => {
      calls++;
      return calls;
    });

    const first = await wrapped();
    const second = await wrapped();

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(calls).toBe(2);
  });

  it("does not poison future calls when the wrapped function rejects", async () => {
    let attempt = 0;
    const wrapped = singleFlight(async () => {
      attempt++;
      if (attempt === 1) throw new Error("boom");
      return "ok";
    });

    await expect(wrapped()).rejects.toThrow("boom");
    await expect(wrapped()).resolves.toBe("ok");
  });

  it("uses only the starting call's arguments for overlapping callers", async () => {
    const seen: number[] = [];
    const wrapped = singleFlight(async (n: number) => {
      seen.push(n);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return n;
    });

    const [a, b] = await Promise.all([wrapped(1), wrapped(2)]);

    expect(seen).toEqual([1]);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("shares a single in-flight rejection across overlapping callers", async () => {
    let calls = 0;
    const wrapped = singleFlight(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("boom");
    });

    const results = await Promise.allSettled([wrapped(), wrapped()]);

    expect(calls).toBe(1);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
  });
});
