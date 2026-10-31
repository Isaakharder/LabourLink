// Unit tests for lib/scaleMatchingRule.ts — no database. Runs the shared
// cases the station's matching.rs also runs, so the two implementations of
// the assignment rule can't drift apart.
//
// Run with: npm run test:scale-matching-rule
import fs from "fs";
import path from "path";
import { Claim, decide, WeighingStatus } from "./scaleMatchingRule";

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

interface VectorClaim {
  id: string;
  employee: string;
  at: number;
  receivedAt?: number;
  clockTrusted?: boolean;
  consumedBy?: string | null;
}
interface Vector {
  name: string;
  weighing: { id: string; at: number; previous: number | null; current: WeighingStatus; employee?: string };
  claims: VectorClaim[];
  now: number;
  expect: { status: WeighingStatus; employee?: string; consume?: string[]; competing?: string[]; conflicts?: string[] };
}

const MIN = 60_000;
const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, "scaleMatching.vectors.json"), "utf8")) as { cases: Vector[] };
check(cases.length >= 20, "the shared vector file loads", cases.length);

for (const v of cases) {
  const claims: Claim[] = v.claims.map((c) => ({
    id: c.id,
    employeeId: c.employee,
    occurredAt: c.at * MIN,
    receivedAt: (c.receivedAt ?? c.at) * MIN,
    clockTrusted: c.clockTrusted ?? true,
    consumedBy: c.consumedBy ?? null,
  }));
  const d = decide(
    {
      id: v.weighing.id,
      weighedAt: v.weighing.at * MIN,
      previousWeighedAt: v.weighing.previous === null ? null : v.weighing.previous * MIN,
      current: v.weighing.current,
      currentEmployeeId: v.weighing.employee ?? null,
    },
    claims,
    v.now * MIN
  );
  const got = {
    status: d.status,
    employee: d.employeeId ?? undefined,
    consume: d.consume,
    competing: d.competing,
    conflicts: d.conflicts,
  };
  const want = { consume: [], competing: [], conflicts: [], ...v.expect };
  const same =
    got.status === want.status &&
    got.employee === want.employee &&
    JSON.stringify(got.consume) === JSON.stringify(want.consume) &&
    JSON.stringify(got.competing) === JSON.stringify(want.competing) &&
    JSON.stringify(got.conflicts) === JSON.stringify(want.conflicts);
  check(same, v.name, { got, want });
  check(d.pendingUntil === (v.weighing.at + 24 * 60) * MIN, `${v.name}: pendingUntil is weighed_at + 24 h`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
