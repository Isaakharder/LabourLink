// Pure rules of matched weighed-bin productivity (lib/scaleProductivity.ts).
// No database. Run with: npm run test:scale-productivity-rules
import {
  BinInput,
  EntryInput,
  evaluateBin,
  excludeOverlappingBins,
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
const t = (m: number) => m * MIN; // minutes since an arbitrary origin
const JOB = "job";

function bin(over: Partial<BinInput> = {}, cycle: Partial<NonNullable<BinInput["cycle"]>> = {}): BinInput {
  return {
    weighingId: "w1",
    carrierId: "binA",
    employeeId: "ana",
    netGrams: 150_000,
    weighedAt: t(60),
    weighDate: "2027-01-05",
    cycle: { employeeId: "ana", openedAt: t(0), otherScanEmployees: 0, openSupersededReviews: 0, previousBoundaryAt: null, ...cycle },
    lateConflicts: 0,
    ...over,
  };
}
const work = (startedAt: number, endedAt: number | null, over: Partial<EntryInput> = {}): EntryInput => ({
  employeeId: "ana",
  carrierId: "binA",
  activityId: JOB,
  startedAt,
  endedAt,
  ...over,
});

// Intervals
check(JSON.stringify(unionIntervals([[0, 10], [5, 20], [30, 40], [40, 50]])) === JSON.stringify([[0, 20], [30, 50]]), "union merges overlapping and touching");
check(JSON.stringify(subtractIntervals([[0, 60]], [[10, 20], [50, 70]])) === JSON.stringify([[0, 10], [20, 50]]), "subtract cuts breaks out");

// Matched time: the cycle window, this bin, this employee, this Job, minus breaks.
{
  const o = evaluateBin(
    bin(),
    JOB,
    [
      work(t(-30), t(10)), // already running at the scan: counts from its start (-30)
      work(t(10), t(40)),
      work(t(30), t(50)), // overlaps the previous entry: counted once
      work(t(55), null), // still open: only up to the weighing (60)
      work(t(60), t(90)), // after the weighing
      work(t(0), t(60), { carrierId: "binB" }), // another bin
    ],
    [{ employeeId: "ana", startedAt: t(20), endedAt: t(25) }, { employeeId: "ben", startedAt: t(0), endedAt: t(60) }]
  );
  check(o.kind === "eligible" && o.matchedMs === t(40 + 40 - 5 + 5), "window, union, open entry clipped at the weighing, own breaks removed", o);
  const floored = evaluateBin(bin({}, { previousBoundaryAt: t(-12) }), JOB, [work(t(-30), t(10))], []);
  check(floored.kind === "eligible" && floored.matchedMs === t(22), "never reaches back past the bin's previous weighing", floored);
  const ended = evaluateBin(bin(), JOB, [work(t(-30), t(-1)), work(t(0), t(10))], []);
  check(ended.kind === "eligible" && ended.matchedMs === t(10), "an earlier entry that ended before the scan is not this bin use", ended);
}

// Exclusions
const reason = (o: ReturnType<typeof evaluateBin>) => (o.kind === "excluded" ? o.reason : o.kind);
check(reason(evaluateBin(bin({ cycle: null }), JOB, [work(t(0), t(60))], [])) === "no_cycle", "no cycle");
check(reason(evaluateBin(bin({}, { employeeId: "ben" }), JOB, [work(t(0), t(60))], [])) === "credit_mismatch", "credited employee is not the cycle's");
check(reason(evaluateBin(bin({}, { otherScanEmployees: 1 }), JOB, [work(t(0), t(60))], [])) === "several_employees", "another employee scanned the bin");
check(
  reason(evaluateBin(bin(), JOB, [work(t(0), t(60)), work(t(20), t(30), { employeeId: "ben" })], [])) === "several_employees",
  "another employee has time with the bin in the window"
);
check(
  reason(evaluateBin(bin(), JOB, [work(t(0), t(60)), work(t(70), t(80), { employeeId: "ben" })], [])) === "eligible",
  "another employee's time after the weighing doesn't matter"
);
check(reason(evaluateBin(bin({}, { openSupersededReviews: 1 }), JOB, [work(t(0), t(60))], [])) === "superseded_review_open", "superseded review open");
check(reason(evaluateBin(bin({ lateConflicts: 1 }), JOB, [work(t(0), t(60))], [])) === "late_conflict", "late conflict");
check(reason(evaluateBin(bin(), JOB, [work(t(0), t(30)), work(t(30), t(60), { activityId: "other" })], [])) === "other_job", "part of the time is another Job");
check(reason(evaluateBin(bin(), JOB, [work(t(0), t(60), { activityId: "other" })], [])) === "other_job_only", "all of the time is another Job: not this Job's bin");
check(reason(evaluateBin(bin(), JOB, [], [])) === "no_matched_time", "no time: excluded, never divided by zero");
check(
  reason(evaluateBin(bin(), JOB, [work(t(0), t(30))], [{ employeeId: "ana", startedAt: t(0), endedAt: null }])) === "no_matched_time",
  "time entirely inside an open break: no matched time"
);

// A minute never counts for two bins.
{
  const a = evaluateBin(bin(), JOB, [work(t(0), t(40))], []);
  const b = evaluateBin(bin({ weighingId: "w2", carrierId: "binB" }), JOB, [work(t(30), t(60), { carrierId: "binB" })], []);
  const c = evaluateBin(bin({ weighingId: "w3", carrierId: "binC", employeeId: "ben" }, { employeeId: "ben" }), JOB, [work(t(30), t(60), { carrierId: "binC", employeeId: "ben" })], []);
  const out = excludeOverlappingBins([a, b, c]);
  check(out.map(reason).join() === "overlapping_time,overlapping_time,eligible", "overlapping bins of one employee are both excluded; another employee's bin is not", out.map(reason));
}

// Ratio of sums, kilograms and minutes together; excluded bins are counted.
{
  const a = evaluateBin(bin({ netGrams: 150_000 }), JOB, [work(t(0), t(60))], []);
  const b = evaluateBin(bin({ weighingId: "w2", carrierId: "binB", netGrams: 120_000, weighedAt: t(150) }, { openedAt: t(120) }), JOB, [work(t(120), t(150), { carrierId: "binB" })], []);
  const x = evaluateBin(bin({ weighingId: "w3", netGrams: 99_000 }, { otherScanEmployees: 1 }), JOB, [], []);
  const s = summarizeByEmployee([a, b, x]).get("ana")!;
  check(s.netGrams === 270_000 && s.matchedSeconds === 90 * 60 && s.bins === 2, "eligible kg and matched time", s);
  check(Math.abs((s.kgPerHour ?? 0) - 180) < 1e-9, "270 kg / 1.5 h = 180 kg/h", s.kgPerHour);
  check(s.excludedBins === 1 && s.excludedNetGrams === 99_000 && s.excludedByReason.several_employees === 1, "excluded bin counted separately", s);
  const none = summarizeByEmployee([x]).get("ana")!;
  check(none.kgPerHour === null && none.bins === 0, "only excluded bins: no figure (not 0)", none);
}

console.log(`scale productivity rules: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
