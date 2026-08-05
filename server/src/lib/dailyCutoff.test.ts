// dailyCutoff.ts also imports the DB pool (for its DB-touching export,
// runDailyCutoff) even though computeCutoffAt itself is pure — db.ts
// throws at import time without DATABASE_URL, so this needs the same
// dotenv bootstrap the CLI scripts use, unlike rowLayout.test.ts's sibling
// module which has no DB import at all.
import "dotenv/config";
import { computeCutoffAt } from "./dailyCutoff";
import { getDayBoundsUtc } from "./timezone";

let pass = 0;
let fail = 0;

function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

// Ordinary date, no DST involved (America/Toronto is EDT / UTC-4 in
// August) — 23:59:59 local on 2026-08-05 is 2026-08-06T03:59:59.000Z.
check(
  computeCutoffAt("2026-08-05").toISOString() === "2026-08-06T03:59:59.000Z",
  "ordinary summer date computes 23:59:59 local correctly",
  computeCutoffAt("2026-08-05").toISOString()
);

// The day BEFORE 2026's spring-forward (clocks jump 2:00am -> 3:00am on
// 2026-03-08) — still EST / UTC-5 all the way through 23:59:59.
check(
  computeCutoffAt("2026-03-07").toISOString() === "2026-03-08T04:59:59.000Z",
  "day before spring-forward uses the pre-DST (EST/UTC-5) offset",
  computeCutoffAt("2026-03-07").toISOString()
);

// The spring-forward day itself — the 2am transition has already happened
// by 23:59:59, so it's EDT / UTC-4 by the time the cutoff instant lands.
check(
  computeCutoffAt("2026-03-08").toISOString() === "2026-03-09T03:59:59.000Z",
  "spring-forward day itself uses the post-DST (EDT/UTC-4) offset",
  computeCutoffAt("2026-03-08").toISOString()
);

// The day BEFORE 2026's fall-back (clocks drop 2:00am -> 1:00am on
// 2026-11-01) — still EDT / UTC-4 all the way through 23:59:59.
check(
  computeCutoffAt("2026-10-31").toISOString() === "2026-11-01T03:59:59.000Z",
  "day before fall-back uses the pre-transition (EDT/UTC-4) offset",
  computeCutoffAt("2026-10-31").toISOString()
);

// The fall-back day itself — the 2am transition has already happened by
// 23:59:59, so it's EST / UTC-5 by the time the cutoff instant lands.
check(
  computeCutoffAt("2026-11-01").toISOString() === "2026-11-02T04:59:59.000Z",
  "fall-back day itself uses the post-transition (EST/UTC-5) offset",
  computeCutoffAt("2026-11-01").toISOString()
);

// The cutoff instant is always exactly one second before the START of the
// next calendar date (getDayBoundsUtc's own `end`), for any date — not a
// fixed 24h-minus-1s offset, which would be wrong on a 23h or 25h DST day.
// Cross-checks computeCutoffAt against the same timezone.ts primitive it's
// built from, independently of any hardcoded expected instant.
for (const d of ["2026-01-01", "2026-06-15", "2026-12-31", "2026-03-08", "2026-11-01"]) {
  const expected = getDayBoundsUtc(d).end.getTime() - 1000;
  check(
    computeCutoffAt(d).getTime() === expected,
    `computeCutoffAt("${d}") equals getDayBoundsUtc(d).end minus 1 second`,
    { got: computeCutoffAt(d).toISOString(), expected: new Date(expected).toISOString() }
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
