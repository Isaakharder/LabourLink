// Pure rules of matched weighed-bin productivity; see scaleProductivity.ts
// for the full description. No database.

export const SCALE_PRODUCTIVITY_START_DATE = "2026-11-24";
export const SCALE_KG_SPEED_UNIT = "kg/hour";

export type BinExclusionReason =
  | "several_employees"
  | "superseded_review_open"
  | "late_conflict"
  | "credit_mismatch"
  | "other_job"
  | "no_matched_time"
  | "overlapping_time"
  | "no_cycle";

export const BIN_EXCLUSION_LABELS: Record<BinExclusionReason, string> = {
  several_employees: "More than one employee picked into this bin",
  superseded_review_open: "An earlier use of this bin by someone else is awaiting review",
  late_conflict: "Another employee claimed this bin after it was credited",
  credit_mismatch: "The credited employee isn't the picking cycle's employee",
  other_job: "Some of this bin's time is under another job",
  no_matched_time: "No picking time matches this bin",
  overlapping_time: "This bin's time overlaps another bin's time",
  no_cycle: "No picking cycle is linked to this weighing",
};

// ---------------------------------------------------------------------------
// Pure part (tested in lib/scaleProductivity.test.ts)
// ---------------------------------------------------------------------------
export type Interval = [number, number]; // [start ms, end ms), start < end

export function unionIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function subtractIntervals(from: Interval[], remove: Interval[]): Interval[] {
  let out = unionIntervals(from);
  for (const [ra, rb] of unionIntervals(remove)) {
    const next: Interval[] = [];
    for (const [a, b] of out) {
      if (rb <= a || ra >= b) next.push([a, b]);
      else {
        if (ra > a) next.push([a, ra]);
        if (rb < b) next.push([rb, b]);
      }
    }
    out = next;
  }
  return out;
}

export const totalMs = (list: Interval[]) => list.reduce((s, [a, b]) => s + (b - a), 0);

export interface BinInput {
  weighingId: string;
  carrierId: string;
  employeeId: string; // the credited employee
  netGrams: number;
  weighedAt: number;
  weighDate: string; // local date of weighed_at
  cycle: {
    employeeId: string;
    openedAt: number;
    otherScanEmployees: number; // distinct scanning employees other than the credited one
    openSupersededReviews: number;
    // The bin's previous weighing or previous cycle end before this cycle
    // opened (null: none). The bin's time never reaches back past it.
    previousBoundaryAt: number | null;
  } | null;
  lateConflicts: number;
}

export interface EntryInput {
  employeeId: string;
  carrierId: string | null;
  activityId: string;
  startedAt: number;
  endedAt: number | null; // null = still open
}

export interface BreakInput {
  employeeId: string;
  startedAt: number;
  endedAt: number | null;
}

export type BinOutcome =
  | { kind: "eligible"; bin: BinInput; matchedMs: number; intervals: Interval[] }
  | { kind: "excluded"; bin: BinInput; reason: BinExclusionReason }
  // All of the bin's time is under a different Job: not this Job's bin.
  | { kind: "other_job_only"; bin: BinInput };

// Decides one bin for one Job. `entries` are every non-deleted work entry
// with this bin that overlaps the bin's window (any employee, any Job);
// `breaks` are the credited employee's non-deleted breaks.
export function evaluateBin(bin: BinInput, jobId: string, entries: EntryInput[], breaks: BreakInput[]): BinOutcome {
  const c = bin.cycle;
  if (!c) return { kind: "excluded", bin, reason: "no_cycle" };
  if (c.employeeId !== bin.employeeId) return { kind: "excluded", bin, reason: "credit_mismatch" };
  if (c.otherScanEmployees > 0) return { kind: "excluded", bin, reason: "several_employees" };
  if (c.openSupersededReviews > 0) return { kind: "excluded", bin, reason: "superseded_review_open" };
  if (bin.lateConflicts > 0) return { kind: "excluded", bin, reason: "late_conflict" };

  const to = bin.weighedAt;
  // The cycle opens at the bin scan, which the phone records a moment after
  // the time entry it belongs to starts. The credited employee's own entry
  // with this bin that is already running when the cycle opens belongs to
  // this bin use, so the bin's time starts at that entry's start (never
  // before the bin's previous weighing or cycle).
  let from = c.openedAt;
  for (const e of entries) {
    if (e.employeeId !== bin.employeeId || e.carrierId !== bin.carrierId) continue;
    if (e.startedAt < c.openedAt && (e.endedAt ?? to) > c.openedAt) {
      from = Math.min(from, Math.max(e.startedAt, c.previousBoundaryAt ?? -Infinity));
    }
  }
  const clip = (e: { startedAt: number; endedAt: number | null }): Interval | null => {
    // An open entry is only used up to the weighing, which is already past.
    const a = Math.max(e.startedAt, from);
    const b = Math.min(e.endedAt ?? to, to);
    return b > a ? [a, b] : null;
  };
  const inWindow = entries.filter((e) => e.carrierId === bin.carrierId).map((e) => ({ e, iv: clip(e) })).filter((x) => x.iv);
  if (inWindow.some((x) => x.e.employeeId !== bin.employeeId)) return { kind: "excluded", bin, reason: "several_employees" };
  const mine = inWindow.filter((x) => x.e.employeeId === bin.employeeId);
  const thisJob = mine.filter((x) => x.e.activityId === jobId);
  if (mine.length > 0 && thisJob.length === 0) return { kind: "other_job_only", bin };
  if (thisJob.length !== mine.length) return { kind: "excluded", bin, reason: "other_job" };

  const breakIvs = breaks
    .filter((b) => b.employeeId === bin.employeeId)
    .map((b) => clip(b))
    .filter((x): x is Interval => x != null);
  const intervals = subtractIntervals(
    thisJob.map((x) => x.iv as Interval),
    breakIvs
  );
  const matchedMs = totalMs(intervals);
  if (matchedMs <= 0) return { kind: "excluded", bin, reason: "no_matched_time" };
  return { kind: "eligible", bin, matchedMs, intervals };
}

// Across one employee's eligible bins: a minute matched to two bins (from
// overlapping time entries with different bins) is a data-quality conflict.
// Both bins are excluded rather than counting the minute twice.
export function excludeOverlappingBins(outcomes: BinOutcome[]): BinOutcome[] {
  const eligible = outcomes.filter((o): o is Extract<BinOutcome, { kind: "eligible" }> => o.kind === "eligible");
  const conflicted = new Set<string>();
  const byEmployee = new Map<string, typeof eligible>();
  for (const o of eligible) {
    const list = byEmployee.get(o.bin.employeeId) ?? [];
    list.push(o);
    byEmployee.set(o.bin.employeeId, list);
  }
  for (const list of byEmployee.values()) {
    const ivs = list.flatMap((o) => o.intervals.map(([a, b]) => ({ a, b, id: o.bin.weighingId })));
    ivs.sort((x, y) => x.a - y.a);
    for (let i = 0; i < ivs.length; i++) {
      for (let j = i + 1; j < ivs.length && ivs[j].a < ivs[i].b; j++) {
        if (ivs[j].id !== ivs[i].id) {
          conflicted.add(ivs[i].id);
          conflicted.add(ivs[j].id);
        }
      }
    }
  }
  return outcomes.map((o) =>
    o.kind === "eligible" && conflicted.has(o.bin.weighingId) ? { kind: "excluded", bin: o.bin, reason: "overlapping_time" as const } : o
  );
}

export interface EmployeeScaleProductivity {
  employeeId: string;
  netGrams: number; // eligible bins only
  matchedSeconds: number; // eligible bins only
  bins: number; // eligible weighed bins
  kgPerHour: number | null; // null when no eligible bin
  excludedBins: number;
  excludedNetGrams: number;
  excludedByReason: Partial<Record<BinExclusionReason, number>>;
}

export function summarizeByEmployee(outcomes: BinOutcome[]): Map<string, EmployeeScaleProductivity> {
  const out = new Map<string, EmployeeScaleProductivity>();
  const get = (id: string) => {
    let e = out.get(id);
    if (!e) {
      e = { employeeId: id, netGrams: 0, matchedSeconds: 0, bins: 0, kgPerHour: null, excludedBins: 0, excludedNetGrams: 0, excludedByReason: {} };
      out.set(id, e);
    }
    return e;
  };
  const ms = new Map<string, number>();
  for (const o of outcomes) {
    if (o.kind === "other_job_only") continue;
    const e = get(o.bin.employeeId);
    if (o.kind === "eligible") {
      e.netGrams += o.bin.netGrams;
      ms.set(e.employeeId, (ms.get(e.employeeId) ?? 0) + o.matchedMs);
      e.bins++;
    } else {
      e.excludedBins++;
      e.excludedNetGrams += o.bin.netGrams;
      e.excludedByReason[o.reason] = (e.excludedByReason[o.reason] ?? 0) + 1;
    }
  }
  for (const e of out.values()) {
    const total = ms.get(e.employeeId) ?? 0;
    e.matchedSeconds = Math.round(total / 1000);
    e.kgPerHour = e.bins > 0 && total > 0 ? e.netGrams / 1000 / (total / 3_600_000) : null;
  }
  return out;
}

export const roundKgPerHour = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

