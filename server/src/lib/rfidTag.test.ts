// Unit tests for lib/rfidTag.ts — no database.
//
// Run with: npm run test:rfid-tag
import { normalizeRfidTag, parseRfidTag } from "./rfidTag";

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

function ok(value: unknown) {
  const r = parseRfidTag(value);
  return r.ok ? r.value : `ERROR: ${r.error}`;
}

check(ok("0000000182225750") === "0000000182225750", "A) leading zeros are preserved");
check(ok("  0000000182225750 \n") === "0000000182225750", "B) surrounding whitespace is trimmed");
check(ok("0000 0001 8222 5750") === "0000000182225750", "C) inner whitespace is removed");
check(ok("e2003412abcd") === "E2003412ABCD", "D) letters are uppercased (hex-style tags)");
check(ok(undefined) === null && ok(null) === null, "E) absent/null means not assigned");
check(ok("") === null && ok("   ") === null, "F) blank means not assigned (clears the tag)");
check(!parseRfidTag(182225750).ok, "G) a number is rejected — identifiers are text, never numeric", parseRfidTag(182225750));
check(!parseRfidTag("R-0000").ok, "H) punctuation is rejected", parseRfidTag("R-0000"));
check(!parseRfidTag("1".repeat(65)).ok, "I) over 64 characters is rejected");
check(parseRfidTag("1".repeat(64)).ok, "J) exactly 64 characters is accepted");
check(normalizeRfidTag("bin 1") === "BIN1", "K) normalizeRfidTag is the same rule used for search");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
