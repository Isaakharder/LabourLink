// Client-side pre-check for the same-row-recently-completed and minimum-
// duration switch warnings — pure, so it runs identically online or
// offline and needs no network round trip to decide whether to show a
// warning dialog before even attempting a switch. The server independently
// re-checks the same two rules on POST /time-entries/work (see
// getCurrentWorkSegment + the isRealSwitch block in mobileTime.ts) as the
// actual enforcement; this is purely for immediate, offline-capable UX —
// see the NFC feature plan for why both layers exist.
//
// Priority order matches the server exactly: same-row is checked first: if
// it fires, minimum-duration is never independently reported for the same
// attempt (see mobileTime.ts's identical ordering).

export interface CurrentWorkContext {
  status: "idle" | "work" | "break";
  currentActivity: {
    id: string;
    startedAt: string;
    accumulatedWorkedSecondsBeforeCurrentEntry: number;
    minimumDurationMinutes: number;
    row: { id: string } | null;
    carrier: { id: string } | null;
  } | null;
  // Most-recent-first, same shape/order as MeResponse.recentJobs.
  recentJobs: {
    activityId: string;
    row: { id: string } | null;
    carrier: { id: string } | null;
  }[];
}

export type SwitchWarning =
  | { kind: "sameRow" }
  | { kind: "minimumDuration"; elapsedSeconds: number; minimumMinutes: number };

export function checkSwitchWarning(
  ctx: CurrentWorkContext,
  newActivityId: string,
  newRowId: string | null,
  newCarrierId: string | null,
  now: Date
): SwitchWarning | null {
  if (ctx.status !== "work" || !ctx.currentActivity) return null;
  const current = ctx.currentActivity;
  const currentRowId = current.row?.id ?? null;
  const currentCarrierId = current.carrier?.id ?? null;

  // Re-selecting exactly what's already running isn't a switch at all —
  // nothing to warn about (and nothing for the server to do either; see
  // submitQuestionFlow's own identical no-op short-circuit).
  const isSameAsCurrent = newActivityId === current.id && newRowId === currentRowId && newCarrierId === currentCarrierId;
  if (isSameAsCurrent) return null;

  const mostRecent = ctx.recentJobs[0];
  if (
    mostRecent &&
    mostRecent.activityId === newActivityId &&
    (mostRecent.row?.id ?? null) === newRowId &&
    (mostRecent.carrier?.id ?? null) === newCarrierId
  ) {
    return { kind: "sameRow" };
  }

  const elapsedSeconds =
    current.accumulatedWorkedSecondsBeforeCurrentEntry +
    Math.max(0, (now.getTime() - new Date(current.startedAt).getTime()) / 1000);
  const minimumSeconds = current.minimumDurationMinutes * 60;
  // Strictly less than: an exact boundary match is allowed without warning
  // (see the NFC feature plan — "an exact minimum boundary is allowed
  // without warning").
  if (elapsedSeconds < minimumSeconds) {
    return {
      kind: "minimumDuration",
      elapsedSeconds: Math.round(elapsedSeconds),
      minimumMinutes: current.minimumDurationMinutes,
    };
  }

  return null;
}
