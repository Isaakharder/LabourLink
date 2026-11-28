// The phone's scheduled-break rules (scheduledBreakDisplay.ts and their use
// in localSessionState.applyLocalEventToMe): on a scheduled break the
// employee stays on it until its scheduled end — an early End Break never
// shows work earlier than the server records it, tapping Start Break again
// is the same break, and at the end the job resumes from that end.
import { describe, expect, it, vi } from "vitest";

vi.mock("./localEventStore", () => ({ getLocalEventStore: vi.fn() }));
vi.mock("./referenceDataCache", () => ({}));

import { applyLocalEventToMe } from "./localSessionState";
import { activeScheduledBreak, applyLocalClockRules, applyScheduledBreakResume, formatBreakTime } from "./scheduledBreakDisplay";
import { MeResponse } from "../context/WorkSessionContext";
import { LocalEvent } from "./localEventStore";

const START = "2026-11-25T17:00:00.000Z"; // 12:00 Toronto
const END = "2026-11-25T18:00:00.000Z"; // 13:00 Toronto

function onLunch(resumeRequested = false): MeResponse {
  return {
    employee: { id: "emp-1", firstName: "A", lastName: "B", preferredLanguage: null, securityRole: "Employee" },
    status: "break",
    currentActivity: null,
    since: START,
    previousActivity: { id: "job-a", name: "Picking", accumulatedWorkedSeconds: 5 * 3600 },
    recentJobs: [],
    appTimezone: "America/Toronto",
    scheduledBreak: {
      name: "Lunch",
      startsAt: START,
      endsAt: END,
      isPaid: false,
      resumeRequested,
      resume: { activityId: "job-a", activityName: "Picking", row: { id: "row-1", label: "P1 · Row 4" }, carrier: null },
    },
  };
}

function ev(eventType: string, occurredAtUtc: string, extra: Partial<LocalEvent> = {}): LocalEvent {
  return {
    clientEventId: `e-${eventType}-${occurredAtUtc}`,
    deviceSeq: 1,
    deviceId: "dev-1",
    employeeId: "emp-1",
    eventType,
    occurredAtUtc,
    localTzOffsetMinutes: -300,
    createdAtLocal: occurredAtUtc,
    syncStatus: "pending",
    syncAttempts: 0,
    lastSyncError: null,
    serverResultJson: null,
    activityId: null,
    greenhouseRowId: null,
    carrierId: null,
    answers: null,
    ...extra,
  } as LocalEvent;
}

describe("scheduled break on the phone", () => {
  it("an early End Break keeps the employee on the break, with the resume pending", () => {
    const next = applyLocalEventToMe(onLunch(), ev("break_end", "2026-11-25T17:30:00.000Z"), {});
    expect(next.status).toBe("break");
    expect(next.since).toBe(START); // the break timer keeps counting from 12:00
    expect(next.currentActivity).toBeNull(); // no work timer before 13:00
    expect(next.scheduledBreak?.resumeRequested).toBe(true);
  });

  it("Start Break again before the end is the same break (cancels the resume)", () => {
    const next = applyLocalEventToMe(onLunch(true), ev("break_start", "2026-11-25T17:31:00.000Z"), {});
    expect(next.status).toBe("break");
    expect(next.since).toBe(START);
    expect(next.scheduledBreak?.resumeRequested).toBe(false);
  });

  it("choosing a job before the end sets the job that resumes at the end", () => {
    const next = applyLocalEventToMe(
      onLunch(),
      ev("activity_switch", "2026-11-25T17:45:00.000Z", { activityId: "job-b" }),
      { activityName: "Pruning" }
    );
    expect(next.status).toBe("break");
    expect(next.scheduledBreak?.resume?.activityId).toBe("job-b");
    expect(next.scheduledBreak?.resumeRequested).toBe(true);
  });

  it("Finish Work during the break ends the day", () => {
    const next = applyLocalEventToMe(onLunch(true), ev("end_day", "2026-11-25T17:50:00.000Z"), {});
    expect(next.status).toBe("idle");
  });

  it("resumes the job at the scheduled end, counting from the end, never earlier", () => {
    const me = onLunch(true);
    expect(applyScheduledBreakResume(me, new Date("2026-11-25T17:59:59.000Z"))).toBe(me);
    const resumed = applyScheduledBreakResume(me, new Date(END));
    expect(resumed.status).toBe("work");
    expect(resumed.currentActivity?.startedAt).toBe(END);
    expect(resumed.currentActivity?.id).toBe("job-a");
    expect(resumed.currentActivity?.row?.id).toBe("row-1");
    // The worked-time total carries on from before the break: no timer runs backwards.
    expect(resumed.currentActivity?.accumulatedWorkedSecondsBeforeCurrentEntry).toBe(5 * 3600);
  });

  it("doesn't resume a break the employee never asked to leave", () => {
    const me = onLunch(false);
    expect(applyLocalClockRules(me, new Date("2026-11-25T19:00:00.000Z"), "America/Toronto")).toBe(me);
  });

  it("a tap after the end applies to the resumed job", () => {
    const next = applyLocalEventToMe(onLunch(true), ev("end_day", "2026-11-25T21:30:00.000Z"), {});
    expect(next.status).toBe("idle");
    const started = applyLocalEventToMe(onLunch(true), ev("break_start", "2026-11-25T20:00:00.000Z"), {});
    expect(started.status).toBe("break");
    expect(started.since).toBe("2026-11-25T20:00:00.000Z");
  });

  it("only applies while the break's end is still ahead", () => {
    expect(activeScheduledBreak(onLunch(), new Date("2026-11-25T17:59:00.000Z"))).not.toBeNull();
    expect(activeScheduledBreak(onLunch(), new Date(END))).toBeNull();
  });

  it("older servers (no scheduledBreak): End Break resumes work at the tap, as before", () => {
    const old = { ...onLunch(), scheduledBreak: undefined };
    const next = applyLocalEventToMe(old, ev("break_end", "2026-11-25T17:30:00.000Z", { activityId: "job-a" }), {});
    expect(next.status).toBe("work");
  });

  it("formats times in the organization's time zone", () => {
    expect(formatBreakTime(END, "America/Toronto")).toBe("1:00 PM");
  });
});
