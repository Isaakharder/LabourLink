// Pure rules of matched weighed-bin productivity with shared-bin allocation;
// see scaleProductivity.ts for the full description. No database.

export const SCALE_PRODUCTIVITY_START_DATE = "2026-11-24";
export const SCALE_KG_SPEED_UNIT = "kg/hour";
// Longest pause in picking at a handover between two employees that still
// counts as one continuous load. Longer pauses (and any handover on a later
// day) make the load boundary uncertain: the bin may have been emptied.
export const HANDOVER_MAX_GAP_MS = 15 * 60_000;

// Why a weighed bin waits for an administrator (counts for nobody until then).
export type LoadReviewReason =
  | "handover_gap"
  | "overnight_handover"
  | "other_job"
  | "overlapping_time"
  | "late_conflict"
  | "inputs_changed";
// Why a weighed bin never counts (not reviewable).
export type LoadExclusionReason = "no_cycle" | "no_matched_time" | "excluded_by_admin";
export type BinExclusionReason = LoadReviewReason | LoadExclusionReason;

export const BIN_EXCLUSION_LABELS: Record<BinExclusionReason, string> = {
  handover_gap: "Picking stopped for more than 15 minutes before another employee continued this bin",
  overnight_handover: "Another employee continued this bin on a later day",
  other_job: "Some of this bin's time is under another job",
  overlapping_time: "An employee's time for this bin overlaps their time for another bin",
  late_conflict: "Another employee's phone claimed this bin after it was weighed",
  inputs_changed: "The time records changed after this allocation was reviewed",
  no_cycle: "No picking cycle is linked to this weighing",
  no_matched_time: "No picking time matches this bin",
  excluded_by_admin: "Excluded by an administrator",
};

// ---------------------------------------------------------------------------
// Intervals
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

export function overlapMs(a: Interval[], b: Interval[]): number {
  let t = 0;
  for (const [x, y] of a) for (const [p, q] of b) t += Math.max(0, Math.min(y, q) - Math.max(x, p));
  return t;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
// One weighed bin load: everything put into a physical bin between its
// previous boundary (previous weighing, administrator "closed without
// weighing", or the start of picking-cycle tracking) and this weighing.
export interface LoadInput {
  weighingId: string;
  carrierId: string;
  creditedEmployeeId: string; // the official scale credit (never changed here)
  netGrams: number;
  weighedAt: number;
  loadStart: number;
  hasCycle: boolean; // this weighing closed a picking cycle
  lateConflicts: number;
  scannerIds: string[]; // employees whose phone chose this bin during the load
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

export interface Contributor {
  employeeId: string;
  matchedMs: number; // this Job's picking with this bin in the load, breaks removed
  intervals: Interval[];
  otherJobMs: number; // time with this bin under another Job
  scanned: boolean;
}

// An administrator's decision (078), as stored.
export interface AllocationDecision {
  action: "confirm" | "override" | "exclude";
  method: "proportional" | "manual" | null;
  fingerprint: string;
  shares: { employeeId: string; included: boolean; allocatedGrams: number }[];
}

export type AllocationBasis = "single" | "shared_auto" | "reviewed_proportional" | "manual";

export interface Share {
  employeeId: string;
  matchedMs: number;
  grams: number;
  intervals: Interval[];
}

export type LoadOutcome =
  | { kind: "allocated"; load: LoadInput; basis: AllocationBasis; shares: Share[]; contributors: Contributor[]; fingerprint: string }
  | { kind: "review"; load: LoadInput; reasons: LoadReviewReason[]; proposal: Share[]; contributors: Contributor[]; fingerprint: string }
  | { kind: "excluded"; load: LoadInput; reason: LoadExclusionReason; contributors: Contributor[]; fingerprint: string }
  // All of the bin's time is under a different Job: not this Job's bin.
  | { kind: "other_job_only"; load: LoadInput };

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
// Every employee with time with this bin inside the load (any Job), their
// matched picking for `jobId` minus their own breaks, and the scanners.
// `entries` may include entries of other bins; `breaks` of any employee.
export function gatherContributors(load: LoadInput, jobId: string, entries: EntryInput[], breaks: BreakInput[]): Contributor[] {
  const clip = (s: number, e: number | null): Interval | null => {
    const a = Math.max(s, load.loadStart);
    const b = Math.min(e ?? load.weighedAt, load.weighedAt);
    return b > a ? [a, b] : null;
  };
  const by = new Map<string, { job: Interval[]; other: Interval[] }>();
  for (const e of entries) {
    if (e.carrierId !== load.carrierId) continue;
    const iv = clip(e.startedAt, e.endedAt);
    if (!iv) continue;
    const x = by.get(e.employeeId) ?? { job: [], other: [] };
    (e.activityId === jobId ? x.job : x.other).push(iv);
    by.set(e.employeeId, x);
  }
  for (const id of load.scannerIds) if (!by.has(id)) by.set(id, { job: [], other: [] });
  const out: Contributor[] = [];
  for (const [employeeId, x] of by) {
    const own = breaks.filter((b) => b.employeeId === employeeId).map((b) => clip(b.startedAt, b.endedAt)).filter((v): v is Interval => v != null);
    const intervals = subtractIntervals(x.job, own);
    out.push({
      employeeId,
      matchedMs: totalMs(intervals),
      intervals,
      otherJobMs: totalMs(subtractIntervals(x.other, own)),
      scanned: load.scannerIds.includes(employeeId),
    });
  }
  return out.sort((a, b) => a.employeeId.localeCompare(b.employeeId));
}

// Handover continuity: walking the bin's picking in time order, each time a
// different employee continues the bin, the pause since anyone last picked
// into it must be at most HANDOVER_MAX_GAP_MS and on the same local day.
// Two employees picking into the bin at the same time is continuous.
export function handoverReasons(contributors: Contributor[], dayOf: (ms: number) => string): LoadReviewReason[] {
  const segs = contributors
    .flatMap((c) => c.intervals.map(([a, b]) => ({ a, b, id: c.employeeId })))
    .sort((x, y) => x.a - y.a || x.b - y.b);
  const reasons = new Set<LoadReviewReason>();
  let lastEnd = -Infinity;
  let lastId: string | null = null;
  for (const s of segs) {
    if (lastId !== null && s.id !== lastId && s.a > lastEnd) {
      if (dayOf(lastEnd) !== dayOf(s.a)) reasons.add("overnight_handover");
      else if (s.a - lastEnd > HANDOVER_MAX_GAP_MS) reasons.add("handover_gap");
    }
    if (s.b >= lastEnd) {
      lastEnd = s.b;
      lastId = s.id;
    }
  }
  return [...reasons];
}

// Integer grams in proportion to weights; always sums exactly to `total`.
// Largest remainder; ties go to the larger weight, then the employee id.
export function allocateGrams(total: number, weights: { employeeId: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const pos = weights.filter((w) => w.weight > 0);
  const sum = pos.reduce((s, w) => s + w.weight, 0);
  for (const w of weights) out.set(w.employeeId, 0);
  if (sum <= 0 || total <= 0) return out;
  const parts = pos.map((w) => {
    const exact = (total * w.weight) / sum;
    const floor = Math.floor(exact);
    return { id: w.employeeId, weight: w.weight, floor, rem: exact - floor };
  });
  let left = total - parts.reduce((s, p) => s + p.floor, 0);
  parts.sort((x, y) => y.rem - x.rem || y.weight - x.weight || x.id.localeCompare(y.id));
  for (const p of parts) {
    out.set(p.id, p.floor + (left > 0 ? 1 : 0));
    if (left > 0) left--;
  }
  return out;
}

// What a decision is tied to: contributing employees with their matched
// seconds, the net weight and the load start.
export function fingerprintOf(load: LoadInput, contributors: Contributor[]): string {
  const parts = contributors
    .filter((c) => c.matchedMs > 0)
    .map((c) => `${c.employeeId}:${Math.round(c.matchedMs / 1000)}`)
    .sort();
  return `v1|${load.netGrams}|${load.loadStart}|${parts.join(",")}`;
}

function proportional(load: LoadInput, contributors: Contributor[], include?: Set<string>): Share[] {
  const eff = contributors.filter((c) => c.matchedMs > 0 && (!include || include.has(c.employeeId)));
  const grams = allocateGrams(load.netGrams, eff.map((c) => ({ employeeId: c.employeeId, weight: c.matchedMs })));
  return eff.map((c) => ({ employeeId: c.employeeId, matchedMs: c.matchedMs, grams: grams.get(c.employeeId) ?? 0, intervals: c.intervals }));
}

// Decides one weighed bin load for one Job.
export function evaluateLoad(
  load: LoadInput,
  jobId: string,
  entries: EntryInput[],
  breaks: BreakInput[],
  decision: AllocationDecision | null,
  dayOf: (ms: number) => string
): LoadOutcome {
  const contributors = gatherContributors(load, jobId, entries, breaks);
  const fingerprint = fingerprintOf(load, contributors);
  if (!load.hasCycle) return { kind: "excluded", load, reason: "no_cycle", contributors, fingerprint };
  const eff = contributors.filter((c) => c.matchedMs > 0);
  if (eff.length === 0) {
    if (contributors.some((c) => c.otherJobMs > 0)) return { kind: "other_job_only", load };
    return { kind: "excluded", load, reason: "no_matched_time", contributors, fingerprint };
  }
  const reasons: LoadReviewReason[] = handoverReasons(eff, dayOf);
  if (contributors.some((c) => c.otherJobMs > 0)) reasons.push("other_job");
  if (load.lateConflicts > 0) reasons.push("late_conflict");
  const proposal = proportional(load, contributors);

  if (decision) {
    if (decision.fingerprint !== fingerprint) return { kind: "review", load, reasons: ["inputs_changed", ...reasons], proposal, contributors, fingerprint };
    if (decision.action === "exclude") return { kind: "excluded", load, reason: "excluded_by_admin", contributors, fingerprint };
    if (decision.action === "confirm") return { kind: "allocated", load, basis: "reviewed_proportional", shares: proposal, contributors, fingerprint };
    const included = new Set(decision.shares.filter((s) => s.included).map((s) => s.employeeId));
    if (decision.method === "proportional") {
      return { kind: "allocated", load, basis: "reviewed_proportional", shares: proportional(load, contributors, included), contributors, fingerprint };
    }
    const grams = new Map(decision.shares.map((s) => [s.employeeId, s.allocatedGrams]));
    const shares = eff
      .filter((c) => included.has(c.employeeId))
      .map((c) => ({ employeeId: c.employeeId, matchedMs: c.matchedMs, grams: grams.get(c.employeeId) ?? 0, intervals: c.intervals }));
    return { kind: "allocated", load, basis: "manual", shares, contributors, fingerprint };
  }
  if (reasons.length) return { kind: "review", load, reasons, proposal, contributors, fingerprint };
  return { kind: "allocated", load, basis: eff.length === 1 ? "single" : "shared_auto", shares: proposal, contributors, fingerprint };
}

// A minute never counts for two bins: when an employee's counted time for
// one bin overlaps their counted time for another, both bins go to review
// (whatever was decided), until a contribution is excluded in one of them.
export function reviewOverlappingLoads(outcomes: LoadOutcome[]): LoadOutcome[] {
  const allocated = outcomes.filter((o): o is Extract<LoadOutcome, { kind: "allocated" }> => o.kind === "allocated");
  const conflicted = new Set<string>();
  const ivs = allocated.flatMap((o) => o.shares.flatMap((s) => s.intervals.map(([a, b]) => ({ a, b, emp: s.employeeId, id: o.load.weighingId }))));
  ivs.sort((x, y) => x.a - y.a);
  for (let i = 0; i < ivs.length; i++) {
    for (let j = i + 1; j < ivs.length && ivs[j].a < ivs[i].b; j++) {
      if (ivs[j].emp === ivs[i].emp && ivs[j].id !== ivs[i].id) {
        conflicted.add(ivs[i].id);
        conflicted.add(ivs[j].id);
      }
    }
  }
  return outcomes.map((o) => {
    if (o.kind !== "allocated" || !conflicted.has(o.load.weighingId)) return o;
    const proposal = proportional(o.load, o.contributors);
    return { kind: "review", load: o.load, reasons: ["overlapping_time"], proposal, contributors: o.contributors, fingerprint: o.fingerprint };
  });
}

export interface EmployeeScaleProductivity {
  employeeId: string;
  netGrams: number; // allocated grams of counted bins
  matchedSeconds: number; // the employee's matched picking of those bins
  bins: number; // counted bins the employee picked into
  sharedBins: number; // of which shared with other employees
  estimatedGrams: number; // grams from shared bins allocated by minutes
  manualGrams: number; // grams set by an administrator
  kgPerHour: number | null; // null when no counted bin
  excludedBins: number; // bins the employee picked into that wait for review or never count
  excludedNetGrams: number; // their proposed share of those
  excludedByReason: Partial<Record<BinExclusionReason, number>>;
}

export function summarizeByEmployee(outcomes: LoadOutcome[]): Map<string, EmployeeScaleProductivity> {
  const out = new Map<string, EmployeeScaleProductivity>();
  const ms = new Map<string, number>();
  const get = (id: string) => {
    let e = out.get(id);
    if (!e) {
      e = { employeeId: id, netGrams: 0, matchedSeconds: 0, bins: 0, sharedBins: 0, estimatedGrams: 0, manualGrams: 0, kgPerHour: null, excludedBins: 0, excludedNetGrams: 0, excludedByReason: {} };
      out.set(id, e);
    }
    return e;
  };
  for (const o of outcomes) {
    if (o.kind === "other_job_only") continue;
    if (o.kind === "allocated") {
      const shared = o.shares.filter((s) => s.matchedMs > 0).length > 1;
      for (const s of o.shares) {
        if (s.matchedMs <= 0 && s.grams <= 0) continue;
        const e = get(s.employeeId);
        e.netGrams += s.grams;
        ms.set(s.employeeId, (ms.get(s.employeeId) ?? 0) + s.matchedMs);
        e.bins++;
        if (shared) e.sharedBins++;
        if (o.basis === "manual") e.manualGrams += s.grams;
        else if (shared) e.estimatedGrams += s.grams;
      }
      continue;
    }
    const people = o.contributors.filter((c) => c.matchedMs > 0);
    const proposal = o.kind === "review" ? new Map(o.proposal.map((s) => [s.employeeId, s.grams])) : new Map<string, number>();
    const reasonList: BinExclusionReason[] = o.kind === "review" ? o.reasons : [o.reason];
    for (const id of people.length ? people.map((c) => c.employeeId) : [o.load.creditedEmployeeId]) {
      const e = get(id);
      e.excludedBins++;
      e.excludedNetGrams += people.length ? proposal.get(id) ?? 0 : o.load.netGrams;
      for (const r of reasonList) e.excludedByReason[r] = (e.excludedByReason[r] ?? 0) + 1;
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
