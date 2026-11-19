import { describe, expect, it } from "vitest";
import { employeeLine, headline, kg, registrationHeadline, statusLabel } from "./format";
import type { RegistrationView } from "./types";
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

  it("says a re-weighed bin with no new phone scan is not credited", () => {
    const p = employeeLine(makeWeighing({ uploadState: "sent", assignmentStatus: "pending", pendingUntil: "2026-10-28T10:00:00Z", noPickingCycle: true }), { phase: "idle" });
    expect(p).toMatchObject({ name: "Not credited: already weighed", tone: "review" });
    expect(p.note).toMatch(/Scan the bin to start a new picking cycle/);
    const e = employeeLine(makeWeighing({ uploadState: "sent", assignmentStatus: "expired", noPickingCycle: true }), { phase: "idle" });
    expect(e.name).toBe("Not credited: already weighed");
    // Without the flag (older server, or a real pending assignment): unchanged.
    expect(employeeLine(makeWeighing({ uploadState: "sent", assignmentStatus: "pending", pendingUntil: "2026-10-28T10:00:00Z" }), { phase: "idle" }).name).toBe("Awaiting employee assignment");
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

  it("warns WAIT when the next bin goes on before the scale returned to zero", () => {
    const s = makeSnapshot({ waitForZero: true, phase: { phase: "awaitingRemoval", reason: "recorded", bin: null, emptySinceMs: null } });
    expect(headline(s)).toMatchObject({ tone: "error", title: "WAIT — Scale must return to zero before next bin." });
    // Cleared once the service reports the scale ready.
    expect(headline(makeSnapshot({ waitForZero: false, phase: { phase: "idle" } })).title).toBe("Ready");
  });

  it("counts down while the tag is read, and refuses an invalid weight instead of waiting", () => {
    expect(headline(makeSnapshot({ phase: { phase: "identifying", startedMs: 0 } })).title).toBe("Reading the bin's tag…");
    const moving = makeSnapshot({
      phase: { phase: "blocked", reason: { code: "weightNotCaptured", why: { code: "moving" } }, bin: null, emptySinceMs: null },
    });
    expect(headline(moving)).toMatchObject({ tone: "error", title: "Weight not valid. Not recorded" });
    expect(headline(moving).detail).toMatch(/still showed motion/);
    const noTag = makeSnapshot({ phase: { phase: "blocked", reason: { code: "noTag" }, bin: null, emptySinceMs: null } });
    expect(headline(noTag).detail).toMatch(/during the 10-second measurement/);
  });

  it("asks for removal after recording, and after a restart with load on the scale", () => {
    expect(headline(makeSnapshot({ phase: { phase: "awaitingRemoval", reason: "recorded", bin: null, emptySinceMs: null } })).title).toBe("Weight recorded");
    expect(headline(makeSnapshot({ phase: { phase: "awaitingRemoval", reason: "startupLoad", bin: null, emptySinceMs: null } })).title).toBe("Remove the bin to begin");
  });
});

describe("trial credits", () => {
  it("never shows a trial match as a credit", () => {
    const w = makeWeighing({ uploadState: "sent", assignmentStatus: "credited", employeeName: "Ruben Ortiz", creditsLive: false });
    const e = employeeLine(w, { phase: "idle" });
    expect(e.name).toBe("Trial: Ruben Ortiz");
    expect(e.tone).toBe("pending");
    expect(e.note).toMatch(/Credits are off/);
    expect(statusLabel(w).tone).not.toBe("credited");
  });

  it("shows a live credit as a credit", () => {
    const w = makeWeighing({ uploadState: "sent", assignmentStatus: "credited", employeeName: "Ruben Ortiz", creditsLive: true });
    expect(employeeLine(w, { phase: "idle" })).toMatchObject({ name: "Ruben Ortiz", tone: "credited" });
  });
});

describe("registrationHeadline", () => {
  const view = (phase: RegistrationView["phase"], scaleOnline = true): RegistrationView => ({
    person: "Pia",
    phase,
    reading: null,
    scaleOnline,
    settleRemainingMs: 0,
    clearRemainingMs: 0,
  });

  it("walks through clearing, measuring, problems and success", () => {
    expect(registrationHeadline(view({ phase: "clearScale", emptySinceMs: null })).title).toBe("Clear the scale");
    expect(registrationHeadline(view({ phase: "ready" })).title).toBe("Place one completely empty bin on the scale");
    expect(registrationHeadline(view({ phase: "measuring", sinceMs: 0, tag: null })).tone).toBe("working");
    const noTag = registrationHeadline(view({ phase: "problem", reason: { code: "noTag" }, emptySinceMs: null }));
    expect(noTag.title).toBe("RFID tag missing");
    expect(noTag.detail).toMatch(/No RFID tag was read for this bin during the 10-second measurement/);
    const swing = registrationHeadline(
      view({ phase: "problem", reason: { code: "weightNotCaptured", why: { code: "unsteady", spreadG: 600 } }, emptySinceMs: null })
    );
    expect(swing).toMatchObject({ tone: "error", title: "Weight not valid" });
    expect(swing.detail).toMatch(/kept changing by 0.60 kg.*Nothing was registered/);
    expect(registrationHeadline(view({ phase: "problem", reason: { code: "multipleTags", tags: ["a", "b"] }, emptySinceMs: null })).tone).toBe("error");
    expect(registrationHeadline(view({ phase: "problem", reason: { code: "indicatorNotGross" }, emptySinceMs: null })).title).toMatch(/gross/);
    const saved = registrationHeadline(view({ phase: "saved", binName: "Bin 77", rfidTag: "t", tareG: 154_400, emptySinceMs: null }));
    expect(saved).toMatchObject({ tone: "done", title: "Bin 77 registered" });
    expect(saved.detail).toMatch(/return to zero/);
    expect(registrationHeadline(view({ phase: "ready" }, false)).title).toBe("Scale not responding");
  });
});
