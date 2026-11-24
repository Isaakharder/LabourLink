// Pure rules of matched weighed-bin productivity with shared-bin allocation
// (lib/scaleProductivityRules.ts). No database.
// Run with: npm run test:scale-productivity-rules
import {
  AllocationDecision,
  allocateGrams,
  BreakInput,
  EntryInput,
  evaluateLoad,
  fingerprintOf,
  gatherContributors,
  handoverReasons,
  HANDOVER_MAX_GAP_MS,
  LoadInput,
  LoadOutcome,
  reviewOverlappingLoads,
  subtractIntervals,
  summarizeByEmployee,
  unionIntervals,
} from "./scaleProductivityRules";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const t = (m: number) => m * MIN; // minutes since an arbitrary origin (day 0 starts at 0)
const dayOf = (ms: number) => String(Math.floor(ms / DAY));
const JOB = "job";

function load(over: Partial<LoadInput> = {}): LoadInput {
  return {
    weighingId: "w1",
    carrierId: "binA",
    creditedEmployeeId: "jose",
    netGrams: 200_000,
    weighedAt: t(120),
    loadStart: t(0),
    hasCycle: true,
    lateConflicts: 0,
    scannerIds: [],
    ...over,
  };
}
const work = (employeeId: string, startedAt: number, endedAt: number | null, over: Partial<EntryInput> = {}): EntryInput => ({
  employeeId,
  carrierId: "binA",
  activityId: JOB,
  startedAt,
  endedAt,
  ...over,
});
const brk = (employeeId: string, startedAt: number, endedAt: number | null): BreakInput => ({ employeeId, startedAt, endedAt });
const grams = (o: LoadOutcome) => (o.kind === "allocated" ? Object.fromEntries(o.shares.map((s) => [s.employeeId, s.grams])) : null);
const mins = (o: LoadOutcome) => (o.kind === "allocated" ? Object.fromEntries(o.shares.map((s) => [s.employeeId, s.matchedMs / MIN])) : null);
const ev = (l: LoadInput, entries: EntryInput[], breaks: BreakInput[] = [], d: AllocationDecision | null = null) => evaluateLoad(l, JOB, entries, breaks, d, dayOf);

// --- Intervals -------------------------------------------------------------
check(JSON.stringify(unionIntervals([[0, 10], [5, 20], [30, 40], [40, 50]])) === JSON.stringify([[0, 20], [30, 50]]), "union merges overlapping and touching");
check(JSON.stringify(subtractIntervals([[0, 60]], [[10, 20], [50, 70]])) === JSON.stringify([[0, 10], [20, 50]]), "subtract cuts breaks out");

// --- allocateGrams: always the exact total, within a gram of exact ----------
{
  const a = allocateGrams(200_000, [{ employeeId: "jose", weight: t(60) }, { employeeId: "jeffrey", weight: t(30) }]);
  check(a.get("jose") === 133_333 && a.get("jeffrey") === 66_667, "200 kg, 60 vs 30 minutes: 133.333 kg and 66.667 kg", [...a]);
  const b = allocateGrams(100_000, [{ employeeId: "a", weight: 1 }, { employeeId: "b", weight: 1 }, { employeeId: "c", weight: 1 }]);
  check([...b.values()].reduce((s, g) => s + g, 0) === 100_000 && b.get("a") === 33_334 && b.get("b") === 33_333, "three equal shares: ties broken by id, exact sum", [...b]);
  const z = allocateGrams(5_000, [{ employeeId: "a", weight: 0 }, { employeeId: "b", weight: 10 }]);
  check(z.get("a") === 0 && z.get("b") === 5_000, "zero minutes get zero grams");
  check([...allocateGrams(5_000, [{ employeeId: "a", weight: 0 }]).values()].every((g) => g === 0), "nobody with minutes: nothing allocated");
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let bad = 0;
  for (let i = 0; i < 3000; i++) {
    const total = Math.floor(rnd() * 400_000);
    const ws = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, k) => ({ employeeId: `e${k}`, weight: Math.floor(rnd() * 5 * 3_600_000) }));
    const sum = ws.reduce((s, w) => s + w.weight, 0);
    const out = allocateGrams(total, ws);
    const got = [...out.values()].reduce((s, g) => s + g, 0);
    if (sum > 0 && got !== total) bad++;
    for (const w of ws) if (sum > 0 && Math.abs((out.get(w.employeeId) ?? 0) - (total * w.weight) / sum) >= 1) bad++;
  }
  check(bad === 0, "3000 random allocations: exact sums, every share within 1 g of exact", bad);
}

// --- Contributors -----------------------------------------------------------
{
  const c = gatherContributors(
    load({ scannerIds: ["stray"] }),
    JOB,
    [
      work("jose", t(-30), t(20)), // started before the load: clipped to the load start
      work("jose", t(10), t(40)), // overlaps his own entry: counted once
      work("jose", t(40), t(70), { carrierId: "binB" }), // another bin: not this one
      work("jeffrey", t(70), t(130)), // after the weighing: clipped to it
      work("jeffrey", t(60), t(70), { activityId: "other" }),
    ],
    [brk("jose", t(30), t(35)), brk("jeffrey", t(100), t(110)), brk("jose", t(80), t(90))]
  );
  const by = Object.fromEntries(c.map((x) => [x.employeeId, x]));
  check(by.jose.matchedMs === t(35), "own entries clipped to the load, overlap once, own break removed", by.jose.matchedMs / MIN);
  check(by.jeffrey.matchedMs === t(40) && by.jeffrey.otherJobMs === t(10), "other employee: clipped at the weighing, own break removed; other Job time kept apart", [by.jeffrey.matchedMs / MIN, by.jeffrey.otherJobMs / MIN]);
  check(by.stray && by.stray.matchedMs === 0 && by.stray.scanned, "a scanner with no picking time is listed with 0 minutes");
}

// --- The example: Jose 60 min, Jeffrey 30 min, 200 kg -----------------------
{
  const o = ev(load(), [work("jose", t(0), t(60)), work("jeffrey", t(60), t(90))]);
  check(o.kind === "allocated" && o.basis === "shared_auto", "continuous handover: allocated automatically", o.kind);
  check(JSON.stringify(grams(o)) === JSON.stringify({ jeffrey: 66_667, jose: 133_333 }), "Jose 133.333 kg, Jeffrey 66.667 kg", grams(o));
  check(JSON.stringify(mins(o)) === JSON.stringify({ jeffrey: 30, jose: 60 }), "each keeps their own minutes", mins(o));
  const s = summarizeByEmployee([o]);
  check(Math.abs((s.get("jose")!.kgPerHour ?? 0) - 133.333) < 0.001 && Math.abs((s.get("jeffrey")!.kgPerHour ?? 0) - 133.334) < 0.001, "both 133.3 kg/hour", [s.get("jose")!.kgPerHour, s.get("jeffrey")!.kgPerHour]);
  check(s.get("jose")!.sharedBins === 1 && s.get("jose")!.estimatedGrams === 133_333 && s.get("jose")!.manualGrams === 0, "shared kilograms counted as estimated");
  check(s.get("jose")!.netGrams + s.get("jeffrey")!.netGrams === 200_000, "the shares add up to the bin");
}

// --- Single employee ----------------------------------------------------------
{
  const o = ev(load(), [work("jose", t(5), t(65))], [brk("jose", t(30), t(40))]);
  check(o.kind === "allocated" && o.basis === "single" && grams(o)!.jose === 200_000 && mins(o)!.jose === 50, "one employee: the whole bin, minutes minus break", [grams(o), mins(o)]);
  const s = summarizeByEmployee([o]).get("jose")!;
  check(s.sharedBins === 0 && s.estimatedGrams === 0, "a single-employee bin is not an estimate");
  // Minutes before the phone scan, after the bin's previous weighing, count.
  const pre = ev(load({ loadStart: t(0) }), [work("jose", t(2), t(10)), work("jose", t(20), t(60))]);
  check(mins(pre)!.jose === 48, "valid pre-scan minutes since the previous weighing count", mins(pre));
  // Same employee overnight (bin left in the row, continued next morning): normal.
  const night = ev(load({ loadStart: t(0), weighedAt: DAY + t(520) }), [work("jose", t(900), t(1020)), work("jose", DAY + t(450), DAY + t(500))]);
  check(night.kind === "allocated" && night.basis === "single" && mins(night)!.jose === 170, "one employee's overnight bin counts normally", night.kind);
  // Same-employee rescan around a stray scan by someone else: one employee.
  const rescan = ev(load({ scannerIds: ["jose", "isaias"] }), [work("jose", t(0), t(37)), work("jose", t(43), t(67))]);
  check(rescan.kind === "allocated" && rescan.basis === "single" && mins(rescan)!.jose === 61 && grams(rescan)!.jose === 200_000, "A, stray scan by B (no time), A again: all A's minutes, whole bin", [rescan.kind, mins(rescan)]);
}

// --- Handover boundaries -------------------------------------------------------
{
  const at = (gap: number) => ev(load(), [work("jose", t(0), t(50)), work("jeffrey", t(50) + gap, t(110))]);
  check(at(HANDOVER_MAX_GAP_MS).kind === "allocated", "a 15-minute pause at the handover is still continuous");
  const gap = at(HANDOVER_MAX_GAP_MS + 1000);
  check(gap.kind === "review" && gap.reasons.includes("handover_gap"), "a longer pause: review, not allocated", gap.kind);
  check(gap.kind === "review" && gap.proposal.reduce((s, x) => s + x.grams, 0) === 200_000, "a review still carries the proposed allocation, exact sum");
  const night = ev(load({ weighedAt: DAY + t(500) }), [work("jose", t(1000), t(1030)), work("jeffrey", DAY + t(450), DAY + t(480))]);
  check(night.kind === "review" && JSON.stringify(night.reasons) === JSON.stringify(["overnight_handover"]), "another employee continuing the next day: review", night.kind === "review" ? night.reasons : night.kind);
  // Several handovers, all continuous.
  const multi = ev(load({ netGrams: 100_000 }), [work("a", t(0), t(20)), work("b", t(20), t(50)), work("c", t(55), t(65)), work("a", t(65), t(105))]);
  check(multi.kind === "allocated" && multi.basis === "shared_auto", "Aâ†’Bâ†’Câ†’A, continuous: allocated", multi.kind);
  check(JSON.stringify(grams(multi)) === JSON.stringify({ a: 60_000, b: 30_000, c: 10_000 }) && JSON.stringify(mins(multi)) === JSON.stringify({ a: 60, b: 30, c: 10 }), "returning employee's minutes are added up once", [grams(multi), mins(multi)]);
  // Two employees picking into the same bin at the same time: continuous.
  const together = ev(load(), [work("jose", t(0), t(60)), work("jeffrey", t(30), t(90))]);
  check(together.kind === "allocated" && grams(together)!.jose === 100_000, "picking into the bin together: shared by minutes", grams(together));
  // A pause by the same employee isn't a handover.
  check(handoverReasons([{ employeeId: "a", matchedMs: 1, intervals: [[t(0), t(10)], [t(200), t(210)]], otherJobMs: 0, scanned: true }], dayOf).length === 0, "the same employee pausing is not a handover");
}

// --- Other exclusions ----------------------------------------------------------
{
  const k = (o: LoadOutcome) => (o.kind === "review" ? o.reasons.join(",") : o.kind === "excluded" ? o.reason : o.kind);
  check(k(ev(load({ hasCycle: false }), [work("jose", t(0), t(60))])) === "no_cycle", "no picking cycle: never counted");
  check(k(ev(load(), [])) === "no_matched_time", "no time: never divided by zero");
  check(k(ev(load(), [work("jose", t(0), t(60), { activityId: "other" })])) === "other_job_only", "all time under another Job: not this Job's bin");
  check(k(ev(load(), [work("jose", t(0), t(30)), work("jose", t(30), t(60), { activityId: "other" })])) === "other_job", "part under another Job: review");
  check(k(ev(load({ lateConflicts: 1 }), [work("jose", t(0), t(60))])) === "late_conflict", "late conflict: review");
  check(k(ev(load(), [work("jose", t(-60), t(-1))])) === "no_matched_time", "time before the bin's previous weighing belongs to the previous load");
}

// --- Administrator decisions ---------------------------------------------------
{
  const l = load();
  const entries = [work("jose", t(0), t(40)), work("jeffrey", t(70), t(100))]; // 30-minute pause: review
  const review = ev(l, entries);
  check(review.kind === "review" && review.reasons.includes("handover_gap"), "starts in review");
  const fp = fingerprintOf(l, gatherContributors(l, JOB, entries, []));
  check(review.kind === "review" && review.fingerprint === fp, "the outcome carries its fingerprint");
  const confirm = ev(l, entries, [], { action: "confirm", method: "proportional", fingerprint: fp, shares: [] });
  check(confirm.kind === "allocated" && confirm.basis === "reviewed_proportional" && grams(confirm)!.jose === 114_286 && grams(confirm)!.jeffrey === 85_714, "confirmed: proportional to minutes", grams(confirm));
  const exclude = ev(l, entries, [], { action: "exclude", method: null, fingerprint: fp, shares: [] });
  check(exclude.kind === "excluded" && exclude.reason === "excluded_by_admin", "excluded by an administrator");
  const drop = ev(l, entries, [], { action: "override", method: "proportional", fingerprint: fp, shares: [{ employeeId: "jose", included: false, allocatedGrams: 0 }, { employeeId: "jeffrey", included: true, allocatedGrams: 0 }] });
  check(drop.kind === "allocated" && JSON.stringify(grams(drop)) === JSON.stringify({ jeffrey: 200_000 }) && mins(drop)!.jeffrey === 30, "an excluded contribution gets neither kilograms nor minutes", [grams(drop), mins(drop)]);
  const manual = ev(l, entries, [], { action: "override", method: "manual", fingerprint: fp, shares: [{ employeeId: "jose", included: true, allocatedGrams: 50_000 }, { employeeId: "jeffrey", included: true, allocatedGrams: 150_000 }] });
  check(manual.kind === "allocated" && manual.basis === "manual" && grams(manual)!.jeffrey === 150_000, "manual kilograms are used as set");
  const ms = summarizeByEmployee([manual]);
  check(ms.get("jeffrey")!.manualGrams === 150_000 && ms.get("jeffrey")!.estimatedGrams === 0, "manual kilograms are not labelled as estimated");
  // Records changed after the decision (a time entry corrected): back to review.
  const changed = ev(l, [work("jose", t(0), t(45)), work("jeffrey", t(70), t(100))], [], { action: "confirm", method: "proportional", fingerprint: fp, shares: [] });
  check(changed.kind === "review" && changed.reasons[0] === "inputs_changed", "a decision never applies to changed records", changed.kind);
  // An automatic shared bin can be decided too, and a reset returns it to the rules.
  const auto = ev(l, [work("jose", t(0), t(60)), work("jeffrey", t(60), t(90))]);
  check(auto.kind === "allocated" && auto.basis === "shared_auto", "without a decision the rules decide again");
}

// --- A minute never counts twice ---------------------------------------------
{
  const a = ev(load({ weighingId: "w1", carrierId: "binA" }), [work("jose", t(0), t(60))]);
  const b = ev(load({ weighingId: "w2", carrierId: "binB" }), [work("jose", t(50), t(110), { carrierId: "binB" })]);
  const c = ev(load({ weighingId: "w3", carrierId: "binC" }), [work("ana", t(0), t(60), { carrierId: "binC" })]);
  const out = reviewOverlappingLoads([a, b, c]);
  check(out[0].kind === "review" && out[1].kind === "review" && out[0].reasons[0] === "overlapping_time", "one employee's overlapping time in two bins: both to review", out.map((o) => o.kind));
  check(out[2].kind === "allocated", "different employees at the same time are fine");
  const s = summarizeByEmployee(out);
  check(s.get("jose")!.bins === 0 && s.get("jose")!.excludedBins === 2 && s.get("jose")!.kgPerHour === null, "nothing counted while overlapping");
  // Two bins handed over between the same employees, back to back: each minute once.
  const x = ev(load({ weighingId: "x", carrierId: "binA", netGrams: 90_000 }), [work("jose", t(0), t(30)), work("jeffrey", t(30), t(60))]);
  const y = ev(load({ weighingId: "y", carrierId: "binB", netGrams: 90_000 }), [work("jeffrey", t(60), t(90), { carrierId: "binB" }), work("jose", t(30), t(60), { carrierId: "binB" })]);
  const both = summarizeByEmployee(reviewOverlappingLoads([x, y]));
  check(both.get("jose")!.matchedSeconds === 3600 && both.get("jeffrey")!.matchedSeconds === 3600 && both.get("jose")!.netGrams + both.get("jeffrey")!.netGrams === 180_000, "two shared bins: every minute and gram once", [...both.values()].map((e) => [e.matchedSeconds, e.netGrams]));
}

// --- Excluded bins are listed against the people who picked them -------------
{
  const r = ev(load(), [work("jose", t(0), t(40)), work("jeffrey", t(70), t(100))]);
  const s = summarizeByEmployee([r]);
  check(s.get("jose")!.excludedBins === 1 && s.get("jeffrey")!.excludedBins === 1 && s.get("jose")!.kgPerHour === null, "a bin in review shows as 'to review' for each picker");
  check(s.get("jose")!.excludedNetGrams + s.get("jeffrey")!.excludedNetGrams === 200_000, "its proposed kilograms are split, not doubled");
}

console.log(`\nscale productivity rules: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
