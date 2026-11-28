// Scheduled breaks on the phone, mirroring the server's rules
// (server/src/lib/scheduledBreaks.ts):
//   - on a scheduled break the employee stays on it until its scheduled
//     end. End Break (or choosing a job) before then only asks to go back,
//     so the phone keeps showing the break — never a work timer that starts
//     earlier than the server's;
//   - another Start Break before the end is the same break (it only cancels
//     that request);
//   - at the scheduled end the phone shows the job resumed from that end,
//     before the server's answer arrives, so the screen never waits on the
//     network and never runs backwards.
// Older servers send no scheduledBreak, and none of this applies.
import { CurrentActivity, MeResponse, ScheduledBreakInfo } from "../context/WorkSessionContext";
import { applyLocalMidnightCutoff } from "./localMidnightCutoff";

// The scheduled break the employee is on, if its end hasn't passed at `at`.
export function activeScheduledBreak(me: MeResponse, at: Date): ScheduledBreakInfo | null {
  if (me.status !== "break" || !me.scheduledBreak) return null;
  return at.getTime() < new Date(me.scheduledBreak.endsAt).getTime() ? me.scheduledBreak : null;
}

// At or after the scheduled end, a requested resume becomes work from the
// end. Returns `me` itself when nothing changes (cheap to call on a timer).
export function applyScheduledBreakResume(me: MeResponse, now: Date): MeResponse {
  const sb = me.status === "break" ? me.scheduledBreak : null;
  if (!sb || !sb.resumeRequested || !sb.resume) return me;
  if (now.getTime() < new Date(sb.endsAt).getTime()) return me;
  const currentActivity: CurrentActivity = {
    id: sb.resume.activityId,
    name: sb.resume.activityName,
    startedAt: sb.endsAt,
    accumulatedWorkedSecondsBeforeCurrentEntry: me.previousActivity?.accumulatedWorkedSeconds ?? 0,
    minimumDurationMinutes: 0,
    row: sb.resume.row,
    carrier: sb.resume.carrier,
  };
  return { ...me, status: "work", currentActivity, since: null, previousActivity: null, scheduledBreak: null };
}

// "1:00 PM" in the organization's time zone.
export function formatBreakTime(iso: string, timeZone: string | undefined): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: timeZone ?? "America/Toronto",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Every time-driven local rule, in order: a due scheduled-break resume, then
// the local midnight cutoff (lib/localMidnightCutoff.ts). Used wherever the
// phone re-derives its state from the clock.
export function applyLocalClockRules(me: MeResponse, now: Date, timeZone: string | undefined): MeResponse {
  return applyLocalMidnightCutoff(applyScheduledBreakResume(me, now), now, timeZone);
}
