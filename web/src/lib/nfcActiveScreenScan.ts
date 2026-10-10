// Pure logic backing HomeScreen's foreground, active-screen NFC scanning —
// kept separate from HomeScreen.tsx (a large stateful component) so the
// actual decisions are unit-testable without mounting React or mocking the
// NFC plugin. HomeScreen.tsx owns the effect wiring (starting/stopping
// lib/nfc.ts's scan session, refs for stale-closure safety, calling
// perform()); this module only decides *whether* scanning should currently
// be active and *what a resolved scan should do*.
//
// Row and carrier ("bin") tags are both accepted here, generically — an
// activity can have a greenhouse_row question, a carrier question, both, or
// neither, and this module never assumes which. The gate activates whenever
// at least one of those questions is configured; the classifier resolves a
// scanned tag against whichever question its own targetType matches, and
// reports "wrong-type" when the activity has no question for that type at
// all (e.g. a bin tag scanned on a row-only activity).
import { QuestionAnswer } from "./activityQuestionTypes";

export interface HomeNfcGateContext {
  // document.visibilityState === "visible" — scanning only runs while
  // Home is actually the foregrounded screen/tab.
  foregrounded: boolean;
  status: "idle" | "work" | "break";
  // true whenever the multi-question flow or single-question-edit sheet is
  // open, or a same-row/minimum-duration warning dialog is pending — any
  // of these already own (or are about to own) the native reader, or are
  // themselves mid-decision and shouldn't be interrupted by a second,
  // independent switch attempt.
  hasCompetingNfcOwner: boolean;
  // The currently-running activity has a configured greenhouse_row
  // question — a row tag scan has nothing to do without one.
  hasRowQuestion: boolean;
  // The currently-running activity has a configured carrier question — a
  // bin tag scan has nothing to do without one.
  hasCarrierQuestion: boolean;
}

// Whether HomeScreen's own foreground scan session should be running right
// now. Re-evaluated on every relevant state change; the caller starts/stops
// lib/nfc.ts's session to match (see the NFC feature plan's scanner
// lifecycle rules — this is every one of those conditions in a single
// testable boolean). Active as soon as the activity has EITHER question
// configured — a dual row+carrier activity like Picking Peppers accepts
// both tag types from the same continuous session, never two separate ones.
export function isHomeNfcScanActive(ctx: HomeNfcGateContext): boolean {
  return (
    ctx.foregrounded &&
    ctx.status === "work" &&
    (ctx.hasRowQuestion || ctx.hasCarrierQuestion) &&
    !ctx.hasCompetingNfcOwner
  );
}

export type TagTargetType = "greenhouse_row" | "carrier";

// Which message an unrecognized tag gets. On iPhone while offline the tag may
// well be registered — it just isn't in this phone's saved list yet — so say
// that instead of "isn't registered". Android keeps its existing message.
export function unknownTagMessageKey(online: boolean, ios: boolean): "nfcTagNotRecognized" | "nfcTagNotSavedOffline" {
  return ios && !online ? "nfcTagNotSavedOffline" : "nfcTagNotRecognized";
}

export type HomeScanOutcome =
  | { kind: "unknown" } // did not resolve to any registered row or bin
  | { kind: "wrong-type"; targetType: TagTargetType } // resolved, but the activity has no question for this tag's type
  | { kind: "already-current"; targetType: TagTargetType } // resolved to the row/bin already being worked
  | { kind: "offline"; targetType: TagTargetType } // a real switch, but the phone has no connectivity right now
  | { kind: "switch"; targetType: TagTargetType; targetId: string; label: string }; // proceed — a genuine, actionable switch

export interface HomeScanResolved {
  targetType: TagTargetType;
  targetId: string;
  label: string;
}

// Classifies a resolved tag scan against the employee's current row/carrier,
// the running activity's configured questions, and connectivity — pure
// decision, no side effects. HomeScreen is responsible for acting on the
// result: `switch` calls the same submit path the picker sheets use (which
// itself still runs the same-row/minimum-duration checks — this function
// only decides whether to attempt a switch at all, not whether that switch
// is safe); every other outcome shows a message and touches nothing.
export function classifyHomeScan(
  resolved: HomeScanResolved | null,
  ctx: {
    hasRowQuestion: boolean;
    hasCarrierQuestion: boolean;
    currentRowId: string | null;
    currentCarrierId: string | null;
    online: boolean;
  }
): HomeScanOutcome {
  if (!resolved) return { kind: "unknown" };

  const hasQuestion = resolved.targetType === "greenhouse_row" ? ctx.hasRowQuestion : ctx.hasCarrierQuestion;
  if (!hasQuestion) return { kind: "wrong-type", targetType: resolved.targetType };

  const currentId = resolved.targetType === "greenhouse_row" ? ctx.currentRowId : ctx.currentCarrierId;
  if (resolved.targetId === currentId) return { kind: "already-current", targetType: resolved.targetType };

  if (!ctx.online) return { kind: "offline", targetType: resolved.targetType };

  return { kind: "switch", targetType: resolved.targetType, targetId: resolved.targetId, label: resolved.label };
}

// Builds the complete answer set a scan-triggered switch submits — the
// currently-answered row/carrier questions carried over unchanged, with only
// the scanned tag's own question replaced by the new value. A scan on a
// dual-question activity is really a hands-free version of the existing
// single-question edit (see HomeScreen's confirmSingleQuestionEdit), and
// must submit the same complete set: the server's work-start endpoint
// validates every configured question on every submit, not just the one
// that changed, so submitting only the scanned question's answer would
// silently drop (or fail validation on) the other one.
export function buildScanSwitchAnswers(
  outcome: Extract<HomeScanOutcome, { kind: "switch" }>,
  ctx: {
    rowQuestionId: string | null;
    carrierQuestionId: string | null;
    currentRowId: string | null;
    currentCarrierId: string | null;
  }
): Record<string, QuestionAnswer> {
  const answers: Record<string, QuestionAnswer> = {};
  if (ctx.rowQuestionId && ctx.currentRowId) {
    answers[ctx.rowQuestionId] = { questionId: ctx.rowQuestionId, questionType: "greenhouse_row", greenhouseRowId: ctx.currentRowId };
  }
  if (ctx.carrierQuestionId && ctx.currentCarrierId) {
    answers[ctx.carrierQuestionId] = { questionId: ctx.carrierQuestionId, questionType: "carrier", carrierId: ctx.currentCarrierId };
  }

  const targetQuestionId = outcome.targetType === "greenhouse_row" ? ctx.rowQuestionId : ctx.carrierQuestionId;
  if (targetQuestionId) {
    answers[targetQuestionId] =
      outcome.targetType === "greenhouse_row"
        ? { questionId: targetQuestionId, questionType: "greenhouse_row", greenhouseRowId: outcome.targetId }
        : { questionId: targetQuestionId, questionType: "carrier", carrierId: outcome.targetId };
  }

  return answers;
}

// ---------------------------------------------------------------------------
// iPhone: what a scanned tag means on Home, for every tag kind (rows, bins,
// activities and the Start Break / End Break / End Work actions). Pure.
// Rules: an action only happens when it makes sense in the current state —
// repeating a scan when already in that state does nothing; a tag never ends
// a break or starts work as a side effect; End Work always asks first; row and
// bin tags keep the existing switching rules (classifyHomeScan).
export type IosHomeScanPlan =
  | { kind: "unknown" }
  | { kind: "row-or-bin"; resolved: HomeScanResolved }
  | { kind: "choose-activity"; activityId: string; label: string }
  | { kind: "start-break" }
  | { kind: "end-break" }
  | { kind: "confirm-end-work" }
  | {
      kind: "nothing";
      reason:
        | "on-break" // a work tag while on a break
        | "not-working" // break/end-work/row/bin tag while not working
        | "already-on-break"
        | "not-on-break"
        | "already-this-activity"
        | "activity-not-available";
      label?: string;
    };

export function planIosHomeScan(
  resolved: { targetType: string; targetId: string; label: string } | null,
  ctx: { status: "idle" | "work" | "break"; currentActivityId: string | null; availableActivityIds: ReadonlySet<string> }
): IosHomeScanPlan {
  if (!resolved) return { kind: "unknown" };
  switch (resolved.targetType) {
    case "greenhouse_row":
    case "carrier":
      if (ctx.status === "break") return { kind: "nothing", reason: "on-break" };
      if (ctx.status !== "work") return { kind: "nothing", reason: "not-working" };
      return { kind: "row-or-bin", resolved: { targetType: resolved.targetType, targetId: resolved.targetId, label: resolved.label } };
    case "activity":
      if (ctx.status === "break") return { kind: "nothing", reason: "on-break", label: resolved.label };
      if (!ctx.availableActivityIds.has(resolved.targetId)) return { kind: "nothing", reason: "activity-not-available", label: resolved.label };
      if (ctx.status === "work" && ctx.currentActivityId === resolved.targetId) {
        return { kind: "nothing", reason: "already-this-activity", label: resolved.label };
      }
      return { kind: "choose-activity", activityId: resolved.targetId, label: resolved.label };
    case "action":
      if (resolved.targetId === "start_break") {
        if (ctx.status === "break") return { kind: "nothing", reason: "already-on-break" };
        if (ctx.status !== "work") return { kind: "nothing", reason: "not-working" };
        return { kind: "start-break" };
      }
      if (resolved.targetId === "end_break") {
        return ctx.status === "break" ? { kind: "end-break" } : { kind: "nothing", reason: "not-on-break" };
      }
      if (resolved.targetId === "end_work") {
        return ctx.status === "idle" ? { kind: "nothing", reason: "not-working" } : { kind: "confirm-end-work" };
      }
      return { kind: "unknown" };
    default:
      return { kind: "unknown" };
  }
}
