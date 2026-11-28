// Plain-English text for scheduled-break occurrences flagged for review
// (break_occurrences.review_reason, set in scheduledBreaks.ts), shown in the
// Inputs "Breaks to review" list. Pure: no database access.
import { APP_TIMEZONE } from "./timezone";

type Kind = "supervisor_entry" | "correction" | "row_completion" | "bin_completion" | "rollover";

interface Blocking {
  entryType: "work" | "break";
  start: string;
  end: string | null;
  kinds: Kind[];
}

export interface OccurrenceReviewInput {
  name: string | null;
  scheduledStart: Date | string;
  scheduledEnd: Date | string;
  reason: string;
  detail: Record<string, any> | null;
}

function time(v: Date | string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(v));
}

const KIND_TEXT: Record<Kind, string> = {
  supervisor_entry: "entered by a supervisor",
  correction: "corrected by a supervisor",
  row_completion: "linked to a row completion",
  bin_completion: "linked to a bin completion",
  rollover: "part of a midnight rollover",
};

function kinds(b: Blocking): string {
  return b.kinds.map((k) => KIND_TEXT[k] ?? k).join(" and ");
}

function span(b: Blocking): string {
  return `${time(b.start)}–${b.end ? time(b.end) : "still open"}`;
}

const EVENT_TEXT: Record<string, string> = {
  end_day: "Finish Work",
  work: "job change",
  break_start: "Start Break",
  break_end: "End Break",
};

const CONFLICT_TEXT: Record<string, string> = {
  edited: "a supervisor has edited this part of the day",
  linked_record: "the work after the break is linked to a completion",
  shift_closed: "the shift had already been closed (midnight cut-off or End Work)",
  later_activity: "activity after the break had already been recorded",
};

export function describeOccurrenceReview(r: OccurrenceReviewInput): string {
  const d = r.detail ?? {};
  const brk = r.name?.trim() || "Scheduled break";
  const head = `${brk} (${time(r.scheduledStart)}–${time(r.scheduledEnd)})`;
  const reversal =
    d.reversal && d.reversal.eventAt
      ? ` It had been added automatically, and was removed when the phone's delayed ${EVENT_TEXT[d.reversal.event] ?? "event"} at ${time(d.reversal.eventAt)} synced.`
      : "";
  switch (r.reason) {
    case "started_after_window_start":
      return `${head} not added: work started at ${time(d.workStart)}, after the break began.${reversal}`;
    case "ended_before_window_end":
      return `${head} not added: work ended at ${time(d.workEnd)}, before the break ended.${reversal}`;
    case "gap_in_work":
      return `${head} not added: no work is recorded ${d.gapFrom ? `from ${time(d.gapFrom)} ` : ""}to ${time(d.gapTo)}.${reversal}`;
    case "existing_break":
      return `${head} not added: another break (${span(d.blocker)}) is already recorded in this window.${reversal}`;
    case "protected_record":
      return `${head} not added: the work ${span(d.blocker)} is ${kinds(d.blocker)}, so it can't be removed.${reversal}`;
    case "waiting_for_shift_end":
      return `${head} not added yet: the job changed during the break and the shift is still open. It is added once the phone syncs activity from after ${time(r.scheduledEnd)}, or the shift closes.${reversal}`;
    case "recovery_window_passed":
      return `${head} not added: the employee worked through it, but it wasn't checked before the recovery window ended (the server was unavailable).`;
    case "tap_shortened": {
      const b: Blocking | null = d.blocker ?? null;
      const why =
        d.cause === "shift_start"
          ? `the shift began at ${time(d.recordedStart)}`
          : d.cause === "protected_record" && b
          ? `the ${b.entryType} ${span(b)} is ${kinds(b)}, so the break starts after it`
          : b
          ? `another break (${span(b)}) ends then`
          : "an earlier record ends then";
      return `${head} recorded from ${time(d.recordedStart)}, not ${time(r.scheduledStart)} (Start Break tapped at ${time(d.tapAt)}): ${why}.`;
    }
    case "tap_ordinary": {
      const b: Blocking | null = d.blocker ?? null;
      const why =
        d.cause === "already_recorded"
          ? "this break is already recorded for the day"
          : d.cause === "protected_record" && b
          ? `the ${b.entryType} ${span(b)} later in the window is ${kinds(b)}`
          : b
          ? `another break (${span(b)}) is recorded later in the window`
          : "another record is in the window";
      return `Start Break at ${time(d.tapAt)} recorded as an ordinary break, not the full ${head}: ${why}.`;
    }
    case "tap_after_supervisor_removed":
      return `Start Break at ${time(d.tapAt)} recorded as an ordinary break: a supervisor had deleted ${head} for this day.`;
    case "late_event_conflict":
      return `The phone's delayed ${EVENT_TEXT[d.event] ?? "event"} at ${time(d.eventAt)} synced after ${head} was added automatically. It couldn't be undone automatically: ${CONFLICT_TEXT[d.cause] ?? "the records have changed"}. Check this day in Inputs.`;
    default:
      return `${head} needs review.`;
  }
}
