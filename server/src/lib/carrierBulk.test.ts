// Pure-function tests for carrierBulk.ts — no database needed, same
// convention as rowLayout.test.ts. Run with: npm run test:carrier-bulk
import {
  MAX_BULK_CARRIERS,
  buildBulkCarrierNames,
  normalizeCarrierName,
  padCarrierNumber,
  parseTareWeightKg,
  validateBulkCarrierRequest,
} from "./carrierBulk";

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

// ---------------------------------------------------------------------
// padCarrierNumber / buildBulkCarrierNames
// ---------------------------------------------------------------------

check(padCarrierNumber(1, 3) === "001", "padCarrierNumber pads to width");
check(padCarrierNumber(50, 3) === "050", "padCarrierNumber pads to width, larger number");
check(padCarrierNumber(100, 2) === "100", "padCarrierNumber never truncates a number wider than the padding");
check(padCarrierNumber(7, null) === "7", "padCarrierNumber with no padding uses the natural string");
check(padCarrierNumber(7, 0) === "7", "padCarrierNumber with padding 0 uses the natural string");

check(
  JSON.stringify(buildBulkCarrierNames("Bin", 1, 3, 3)) === JSON.stringify(["Bin 001", "Bin 002", "Bin 003"]),
  "buildBulkCarrierNames matches the feature request's example"
);
check(
  JSON.stringify(buildBulkCarrierNames("Bin", 1, 50, 3)).includes('"Bin 050"') &&
    buildBulkCarrierNames("Bin", 1, 50, 3).length === 50,
  "buildBulkCarrierNames 1..50 padding 3 creates 50 names ending in Bin 050"
);
check(
  JSON.stringify(buildBulkCarrierNames("Carrier", 5, 5, null)) === JSON.stringify(["Carrier 5"]),
  "buildBulkCarrierNames with start === end creates exactly one name"
);
{
  const names = buildBulkCarrierNames("Bin", 1, 100, null);
  check(new Set(names).size === names.length, "buildBulkCarrierNames never produces intra-batch duplicates");
}

check(normalizeCarrierName("  Bin 001  ") === "bin 001", "normalizeCarrierName trims and lowercases");

// ---------------------------------------------------------------------
// parseTareWeightKg
// ---------------------------------------------------------------------

check(parseTareWeightKg(27.5).ok === true && (parseTareWeightKg(27.5) as any).value === 27.5, "parseTareWeightKg accepts a decimal");
check(parseTareWeightKg(0).ok === true, "parseTareWeightKg accepts exactly 0");
check(parseTareWeightKg(-0.01).ok === false, "parseTareWeightKg rejects a negative value");
check(parseTareWeightKg(undefined).ok === false, "parseTareWeightKg rejects undefined (required)");
check(parseTareWeightKg(null).ok === false, "parseTareWeightKg rejects null (required)");
check(parseTareWeightKg("").ok === false, "parseTareWeightKg rejects an empty string (required)");
check(parseTareWeightKg("not a number").ok === false, "parseTareWeightKg rejects a non-numeric string");
check(parseTareWeightKg("12.3").ok === true && (parseTareWeightKg("12.3") as any).value === 12.3, "parseTareWeightKg accepts a numeric string");
check(
  (parseTareWeightKg(1.005) as any).value === 1.01 || (parseTareWeightKg(1.005) as any).value === 1,
  "parseTareWeightKg rounds to 2 decimal places without throwing"
);

// ---------------------------------------------------------------------
// validateBulkCarrierRequest
// ---------------------------------------------------------------------

{
  const result = validateBulkCarrierRequest({
    prefix: "Bin",
    startNumber: 1,
    endNumber: 50,
    padding: 3,
    tareWeightKg: 27.5,
    notes: "Standard bin",
    isActive: true,
  });
  check(result.ok === true, "validateBulkCarrierRequest accepts a valid request", result);
  if (result.ok) {
    check(result.request.prefix === "Bin", "validateBulkCarrierRequest trims/keeps prefix");
    check(result.request.tareWeightKg === 27.5, "validateBulkCarrierRequest carries through tareWeightKg");
  }
}

check(
  validateBulkCarrierRequest({ prefix: "", startNumber: 1, endNumber: 5, tareWeightKg: 0 }).ok === false,
  "validateBulkCarrierRequest rejects an empty prefix"
);
check(
  validateBulkCarrierRequest({ prefix: "  ", startNumber: 1, endNumber: 5, tareWeightKg: 0 }).ok === false,
  "validateBulkCarrierRequest rejects a whitespace-only prefix"
);
check(
  validateBulkCarrierRequest({ prefix: "Bin", startNumber: 10, endNumber: 5, tareWeightKg: 0 }).ok === false,
  "validateBulkCarrierRequest rejects endNumber < startNumber"
);
check(
  validateBulkCarrierRequest({ prefix: "Bin", startNumber: -1, endNumber: 5, tareWeightKg: 0 }).ok === false,
  "validateBulkCarrierRequest rejects a negative startNumber"
);
check(
  validateBulkCarrierRequest({ prefix: "Bin", startNumber: 1.5, endNumber: 5, tareWeightKg: 0 }).ok === false,
  "validateBulkCarrierRequest rejects a non-integer startNumber"
);
check(
  validateBulkCarrierRequest({ prefix: "Bin", startNumber: 1, endNumber: 1 + MAX_BULK_CARRIERS, tareWeightKg: 0 }).ok === false,
  "validateBulkCarrierRequest rejects a range exceeding MAX_BULK_CARRIERS"
);
check(
  validateBulkCarrierRequest({ prefix: "Bin", startNumber: 1, endNumber: MAX_BULK_CARRIERS, tareWeightKg: 0 }).ok === true,
  "validateBulkCarrierRequest accepts a range exactly at MAX_BULK_CARRIERS"
);
check(
  validateBulkCarrierRequest({ prefix: "Bin", startNumber: 1, endNumber: 5, padding: -1, tareWeightKg: 0 }).ok === false,
  "validateBulkCarrierRequest rejects negative padding"
);
check(
  validateBulkCarrierRequest({ prefix: "Bin", startNumber: 1, endNumber: 5, padding: 11, tareWeightKg: 0 }).ok === false,
  "validateBulkCarrierRequest rejects padding above 10"
);
check(
  validateBulkCarrierRequest({ prefix: "Bin", startNumber: 1, endNumber: 5, tareWeightKg: -3 }).ok === false,
  "validateBulkCarrierRequest rejects a negative tareWeightKg"
);
check(
  validateBulkCarrierRequest({ prefix: "Bin", startNumber: 1, endNumber: 5 }).ok === false,
  "validateBulkCarrierRequest rejects a missing tareWeightKg"
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
