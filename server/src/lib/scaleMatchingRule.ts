// Assigns each scale weighing to the employee who filled the bin, from phone
// evidence only. Server port of the station's reference implementation
// (scale/service/src/matching.rs); both run the shared cases in
// scaleMatching.vectors.json.
//
// A bin-use cycle for carrier X weighed at T is (previous weighing of X, T].
// Every weighing closes a cycle whatever its outcome, so consecutive uses of
// one bin are independent. A bin's first-ever weighing has no previous one;
// its cycle starts FIRST_CYCLE_LOOKBACK_MS before it, so an old scan from
// before the station existed can't credit it.
//
// A *claim* is an accepted phone work_start/activity_switch event whose
// validated answers chose bin X (scanned by NFC or picked by hand: both are
// accepted bin switches). Resuming after a break is not a claim. A claim
// counts only if:
//   - it happened inside the cycle;
//   - the phone clock was not flagged (backward jump / ahead of the server);
//   - the server received it no later than the weighing's pending_until
//     (weighed_at + 24 h) — so the outcome never depends on when this code
//     happens to run;
//   - no other weighing has consumed it (scale_weighing_claims' primary key).
//
// Outcome for a pending weighing:
//   exactly one employee  -> credited; their claims are consumed
//   two or more           -> needs_review, nobody credited (claims flagged "competing")
//   none, before deadline -> pending
//   none, after deadline  -> expired, never credited
// Credited, needs_review, expired and voided are final. A later claim by a
// different employee inside a credited cycle is flagged "late_conflict"; the
// credit is unchanged. A later claim by the credited employee is absorbed.
export const PENDING_RECOVERY_MS = 24 * 60 * 60 * 1000;
export const FIRST_CYCLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const DUPLICATE_GUARD_MS = 5 * 60 * 1000;
// A weighing time this far ahead of the server's clock means the station
// clock is wrong; such a weighing is held for review, never credited.
export const STATION_CLOCK_AHEAD_LIMIT_MS = 5 * 60 * 1000;

export type WeighingStatus = "pending" | "credited" | "needs_review" | "expired" | "voided";

export interface Claim {
  id: string;
  employeeId: string;
  occurredAt: number;
  receivedAt: number;
  clockTrusted: boolean;
  consumedBy: string | null;
}

export interface WeighingFacts {
  id: string;
  weighedAt: number;
  previousWeighedAt: number | null;
  current: WeighingStatus;
  currentEmployeeId: string | null;
}

export interface Decision {
  status: WeighingStatus;
  employeeId: string | null;
  consume: string[];
  competing: string[];
  conflicts: string[];
  pendingUntil: number;
}

export function cycleStart(w: Pick<WeighingFacts, "weighedAt" | "previousWeighedAt">): number {
  return w.previousWeighedAt ?? w.weighedAt - FIRST_CYCLE_LOOKBACK_MS;
}

export function decide(w: WeighingFacts, claims: Claim[], now: number): Decision {
  const pendingUntil = w.weighedAt + PENDING_RECOVERY_MS;
  const start = cycleStart(w);
  const eligible = claims.filter(
    (c) =>
      c.occurredAt > start &&
      c.occurredAt <= w.weighedAt &&
      c.clockTrusted &&
      c.receivedAt <= pendingUntil &&
      (c.consumedBy === null || c.consumedBy === w.id)
  );
  const unchanged = (status: WeighingStatus, employeeId: string | null = null): Decision => ({
    status,
    employeeId,
    consume: [],
    competing: [],
    conflicts: [],
    pendingUntil,
  });

  if (w.current === "credited") {
    const same = eligible.filter((c) => c.employeeId === w.currentEmployeeId);
    const other = eligible.filter((c) => c.employeeId !== w.currentEmployeeId);
    return {
      ...unchanged("credited", w.currentEmployeeId),
      consume: same.filter((c) => c.consumedBy === null).map((c) => c.id),
      conflicts: other.map((c) => c.id),
    };
  }
  if (w.current !== "pending") return unchanged(w.current, w.currentEmployeeId);

  const employees = [...new Set(eligible.map((c) => c.employeeId))];
  if (employees.length === 1) {
    return { ...unchanged("credited", employees[0]), consume: eligible.map((c) => c.id) };
  }
  if (employees.length > 1) {
    return { ...unchanged("needs_review"), competing: eligible.map((c) => c.id) };
  }
  return unchanged(now >= pendingUntil ? "expired" : "pending");
}
