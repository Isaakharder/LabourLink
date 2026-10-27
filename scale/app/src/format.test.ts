import { describe, expect, it } from "vitest";
import { employeeLine, headline, kg } from "./format";
import { makeSnapshot, makeWeighing } from "./testFixtures";

describe("kg", () => {
  it("formats grams as kg with two decimals and a real minus sign", () => {
    expect(kg(36_880)).toBe("36.88");
    expect(kg(-40)).toBe("−0.04");
    expect(kg(null)).toBe("—");
  });
});

describe("employeeLine: only a server-verified assignment shows a name", () => {
  it("shows the credited employee", () => {
    const l = employeeLine(makeWeighing({ uploadState: "sent", assignmentStatus: "credited", employeeName: "Picker Alpha" }), { phase: "idle" });
    expect(l).toMatchObject({ name: "Picker Alpha", tone: "credited" });
  });

  it("never shows a name for pending, review, expired or unsent weighings", () => {
    for (const w of [
      makeWeighing({ uploadState: "queued", employeeName: "Picker Alpha" }),
      makeWeighing({ uploadState: "sent", assignmentStatus: "pending", pendingUntil: "2026-10-28T10:00:00Z" }),
      makeWeighing({ uploadState: "sent", assignmentStatus: "needs_review" }),
      makeWeighing({ uploadState: "sent", assignmentStatus: "expired" }),
      makeWeighing({ uploadState: "rejected", lastError: "Unknown carrier" }),
      // Server reported something the station doesn't recognise, or a correction voided it.
      makeWeighing({ uploadState: "sent", assignmentStatus: "unknown", employeeName: "Picker Alpha" }),
      makeWeighing({ uploadState: "sent", assignmentStatus: "voided", employeeName: "Picker Alpha" }),
      makeWeighing({ uploadState: "sent", assignmentStatus: "needs_review", employeeName: "Picker Alpha" }),
    ]) {
      const l = employeeLine(w, { phase: "idle" });
      expect(l.name).not.toBe("Picker Alpha");
      expect(l.tone).not.toBe("credited");
    }
  });

  it("labels an expired weighing as discarded and not credited", () => {
    const l = employeeLine(makeWeighing({ uploadState: "sent", assignmentStatus: "expired", employeeName: null }), { phase: "idle" });
    expect(l).toMatchObject({ name: "Not credited", tone: "review" });
    expect(l.note).toMatch(/discarded/);
  });

  it("explains the 24 h hold for pending weighings", () => {
    const l = employeeLine(makeWeighing({ uploadState: "sent", assignmentStatus: "pending", pendingUntil: "2026-10-28T10:00:00Z" }), { phase: "idle" });
    expect(l.name).toBe("Awaiting employee assignment");
    expect(l.note).toMatch(/24 h/);
  });
});

describe("headline", () => {
  it("pauses weighing visibly when the scale stops sending", () => {
    expect(headline(makeSnapshot({ scaleOnline: false })).title).toBe("Scale not responding");
  });

  it("names the blocking problem", () => {
    const s = makeSnapshot({
      phase: { phase: "blocked", reason: { code: "multipleTags", tags: ["A", "B"] }, bin: null, emptySinceMs: null },
    });
    expect(headline(s)).toMatchObject({ tone: "error", title: "More than one bin detected" });
    const unknown = makeSnapshot({ phase: { phase: "blocked", reason: { code: "unknownTag", tag: "0000000099999999" }, bin: null, emptySinceMs: null } });
    expect(headline(unknown).detail).toContain("0000000099999999");
  });

  it("asks for removal after recording, and after a restart with load on the scale", () => {
    expect(headline(makeSnapshot({ phase: { phase: "awaitingRemoval", reason: "recorded", bin: null, emptySinceMs: null } })).title).toBe("Weight recorded");
    expect(headline(makeSnapshot({ phase: { phase: "awaitingRemoval", reason: "startupLoad", bin: null, emptySinceMs: null } })).title).toBe("Remove the bin to begin");
  });
});
