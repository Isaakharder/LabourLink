// Pure variety planting maths (lib/varietyPlanting.ts): per-row estimates
// proportional to saved row length (equal rows equal, shares adding up to
// the plants planted) and the density summary. No database.
//
// Run with: npm run test:variety-planting
import { estimatePlantsByLength, METRES_PER_FOOT, summarizePlanting } from "./varietyPlanting";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}
const sum = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + n, 0);
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// Equal rows split evenly.
{
  const m = estimatePlantsByLength(1272, [
    { id: "a", lengthFt: 192 },
    { id: "b", lengthFt: 192 },
    { id: "c", lengthFt: 192 },
    { id: "d", lengthFt: 192 },
  ]);
  check([...m.values()].every((n) => n === 318), "equal rows get equal shares", [...m]);
}

// Equal rows stay equal even when the total doesn't divide evenly.
{
  const m = estimatePlantsByLength(10, [
    { id: "a", lengthFt: 100 },
    { id: "b", lengthFt: 100 },
    { id: "c", lengthFt: 100 },
  ]);
  check(new Set([...m.values()]).size === 1 && close(sum(m), 10), "10 plants over 3 equal rows: three equal shares adding up to 10", [...m]);
}

// Proportional to length (300 ft vs 330 ft, like Phase 2's two lengths).
{
  const m = estimatePlantsByLength(1050, [
    { id: "short", lengthFt: 300 },
    { id: "long", lengthFt: 330 },
  ]);
  check(close(m.get("short")!, 500) && close(m.get("long")!, 550), "shares are proportional to length (300:330 -> 500:550)", [...m]);
}

// Many uneven rows: the shares add up to the plants planted.
{
  const rows = Array.from({ length: 467 }, (_, i) => ({ id: `r${i}`, lengthFt: 150 + ((i * 37) % 90) }));
  const m = estimatePlantsByLength(148_513, rows);
  check(Math.abs(sum(m) - 148_513) < 1e-6 && m.size === 467, "467 uneven rows: shares add up to the plants planted", { total: sum(m), size: m.size });
}

// Nothing to estimate.
check(estimatePlantsByLength(null, [{ id: "a", lengthFt: 10 }]).size === 0, "no plants recorded -> no estimates");
check(estimatePlantsByLength(500, []).size === 0, "no rows -> no estimates");
check(estimatePlantsByLength(0, [{ id: "a", lengthFt: 10 }]).size === 0, "zero plants -> no estimates");

// Summary.
{
  const s = summarizePlanting(1272, [
    { id: "a", lengthFt: 192 },
    { id: "b", lengthFt: 192 },
    { id: "c", lengthFt: 192 },
    { id: "d", lengthFt: 192 },
  ]);
  const metres = 4 * 192 * METRES_PER_FOOT;
  check(s.rows === 4 && s.totalLengthFt === 768, "summary counts rows and length", s);
  check(close(s.totalLengthM, metres), "length converted to metres (1 ft = 0.3048 m)", s.totalLengthM);
  check(close(s.plantsPerMetre!, 1272 / metres), "plants per metre = plants / total metres", s.plantsPerMetre);
  check(s.averageEstimatedPlantsPerRow === 318, "average estimated plants per row = plants / rows", s.averageEstimatedPlantsPerRow);
  const empty = summarizePlanting(null, [{ id: "a", lengthFt: 192 }]);
  check(empty.plantsPerMetre === null && empty.averageEstimatedPlantsPerRow === null && empty.totalLengthFt === 192, "no plants recorded: length shown, no density", empty);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
