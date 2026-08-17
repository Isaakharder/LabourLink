// Client-side-only PREVIEW of what server/src/routes/inputs.ts's
// planBreakInsertion will do with the currently-typed break range — purely
// informational, computed from data the Inputs page already has loaded
// (today's runs). The server is still the sole authority on whether the
// break is actually accepted and how it's applied; this only replaces the
// old "this will be rejected" framing with an honest "here's what will
// happen" one for the cases that are no longer rejected at all.
import { APP_TIMEZONE } from "./timezone";

export interface BreakPreviewRun {
  activityName: string;
  startedAt: string;
  endedAt: string | null;
}

// "12:00 PM" — no seconds, unlike formatTimeInAppTimezone (timezone.ts),
// which is a touch too precise for a plain-language preview sentence.
function formatClockTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

// Returns a short, non-blocking sentence describing what adding this break
// will do to the day's existing activities, or null when there's nothing
// to explain (no overlap, or the range isn't valid/complete yet). Mirrors
// planBreakInsertion's own classification (split / one-boundary trim /
// fully covered / break-spans-multiple) without needing the server.
export function describeBreakSplitEffect(
  runs: BreakPreviewRun[],
  breakStartIso: string,
  breakEndIso: string
): string | null {
  const breakStart = new Date(breakStartIso).getTime();
  const breakEnd = new Date(breakEndIso).getTime();
  if (!Number.isFinite(breakStart) || !Number.isFinite(breakEnd) || breakEnd <= breakStart) return null;

  const overlapping = runs.filter((r) => {
    const runStart = new Date(r.startedAt).getTime();
    const runEnd = r.endedAt ? new Date(r.endedAt).getTime() : null;
    return runStart < breakEnd && (runEnd === null || runEnd > breakStart);
  });
  if (overlapping.length === 0) return null;

  const rangeLabel = `${formatClockTime(breakStartIso)}–${formatClockTime(breakEndIso)}`;

  if (overlapping.length > 1) {
    return `This will adjust ${overlapping.length} existing activities around the ${rangeLabel} break.`;
  }

  const r = overlapping[0];
  const runStart = new Date(r.startedAt).getTime();
  const runEnd = r.endedAt ? new Date(r.endedAt).getTime() : null;

  if (runEnd === null) {
    // In-progress activity — the server still rejects this outright (an
    // open-ended entry can't be split), so no "this will..." preview.
    return null;
  }
  if (runStart < breakStart && runEnd > breakEnd) {
    return `This will split ${r.activityName} around the ${rangeLabel} break.`;
  }
  if (runStart >= breakStart && runEnd <= breakEnd) {
    return `This will remove ${r.activityName} (${formatClockTime(r.startedAt)}–${formatClockTime(
      r.endedAt!
    )}), which the new break fully covers.`;
  }
  if (runStart < breakStart) {
    return `This will trim ${r.activityName} to end at ${formatClockTime(breakStartIso)}.`;
  }
  return `This will trim ${r.activityName} to start at ${formatClockTime(breakEndIso)}.`;
}
