// Pure logic backing HomeScreen's foreground, active-screen NFC row
// scanning — kept separate from HomeScreen.tsx (a large stateful
// component) so the actual decisions are unit-testable without mounting
// React or mocking the NFC plugin. HomeScreen.tsx owns the effect wiring
// (starting/stopping lib/nfc.ts's scan session, refs for stale-closure
// safety, calling perform()); this module only decides *whether* scanning
// should currently be active and *what a resolved scan should do*.

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
  // question — a carrier-only or plain activity has nothing for a row
  // scan to switch, so scanning never starts for those.
  isRowBasedActivity: boolean;
}

// Whether HomeScreen's own foreground row-scan session should be running
// right now. Re-evaluated on every relevant state change; the caller
// starts/stops lib/nfc.ts's session to match (see the NFC feature plan's
// scanner lifecycle rules — this is every one of those conditions in a
// single testable boolean).
export function isHomeNfcScanActive(ctx: HomeNfcGateContext): boolean {
  return ctx.foregrounded && ctx.status === "work" && ctx.isRowBasedActivity && !ctx.hasCompetingNfcOwner;
}

export type HomeRowScanOutcome =
  | { kind: "unknown" } // did not resolve to any registered row or bin
  | { kind: "wrong-type" } // resolved, but to a bin — must never change the row
  | { kind: "already-current-row" } // resolved to the row already being worked
  | { kind: "offline" } // a real switch, but the phone has no connectivity right now
  | { kind: "switch"; rowId: string }; // proceed — a genuine, actionable row switch

export interface HomeRowScanResolved {
  targetType: "greenhouse_row" | "carrier";
  targetId: string;
}

// Classifies a resolved tag scan against the employee's current row and
// connectivity — pure decision, no side effects. HomeScreen is responsible
// for acting on the result: `switch` calls the same submit path the picker
// sheets use (which itself still runs the same-row/minimum-duration
// checks — this function only decides whether to attempt a switch at all,
// not whether that switch is safe); every other outcome shows a message
// and touches nothing.
export function classifyHomeRowScan(
  resolved: HomeRowScanResolved | null,
  ctx: { currentRowId: string | null; online: boolean }
): HomeRowScanOutcome {
  if (!resolved) return { kind: "unknown" };
  if (resolved.targetType !== "greenhouse_row") return { kind: "wrong-type" };
  if (resolved.targetId === ctx.currentRowId) return { kind: "already-current-row" };
  if (!ctx.online) return { kind: "offline" };
  return { kind: "switch", rowId: resolved.targetId };
}
