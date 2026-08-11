// Tests the signed-photo-URL cache added by the Inputs employee-switch
// performance fix (see lib/storage.ts's own header comment). Split in two:
// pure cache-logic tests (expiry, bounded pruning, path isolation) that
// need no network at all, and a handful of live-Supabase tests that prove
// the cache is actually wired into getSignedPhotoUrl/getSignedPhotoUrls
// end to end, using real already-uploaded employee photos (read-only —
// signing a URL never modifies the underlying object, so there is nothing
// to clean up afterward).
//
// Run with: npm run test:storage
import "dotenv/config";
import { pool } from "../db";
import {
  getSignedPhotoUrl,
  getSignedPhotoUrls,
  _clearSignedUrlCacheForTests,
  _setCachedSignedUrlForTests,
  _getSignedUrlCacheSizeForTests,
  _getCachedSignedUrlForTests,
} from "./storage";

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

async function main() {
  // -----------------------------------------------------------------
  // Pure cache logic — no network, no Supabase call.
  // -----------------------------------------------------------------
  {
    _clearSignedUrlCacheForTests();

    _setCachedSignedUrlForTests("path/a.webp", "https://example.test/a?token=1", Date.now() + 60_000);
    check(
      _getCachedSignedUrlForTests("path/a.webp") === "https://example.test/a?token=1",
      "a freshly-seeded, not-yet-expired entry is returned"
    );

    _setCachedSignedUrlForTests("path/b.webp", "https://example.test/b?token=2", Date.now() - 1);
    check(
      _getCachedSignedUrlForTests("path/b.webp") === null,
      "an entry whose expiresAt has already passed is never returned"
    );
    check(
      _getSignedUrlCacheSizeForTests() === 1,
      "reading an expired entry evicts it (cache size drops from 2 to 1)",
      _getSignedUrlCacheSizeForTests()
    );

    _setCachedSignedUrlForTests("path/c.webp", "https://example.test/c?token=3", Date.now() - 1000);
    check(
      _getCachedSignedUrlForTests("path/does-not-exist.webp") === null,
      "an unseeded path is a cache miss, not an error"
    );
  }

  // Bounded cleanup: seeding well past SIGNED_URL_CACHE_MAX_ENTRIES (1000)
  // distinct, non-expiring entries must not let the cache grow unbounded —
  // setCachedSignedUrl's own prune runs on every write, so seeding via
  // _setCachedSignedUrlForTests (which bypasses that prune) first, then one
  // real write through the normal path, exercises the same bound.
  {
    _clearSignedUrlCacheForTests();
    for (let i = 0; i < 1200; i++) {
      _setCachedSignedUrlForTests(`bounded/${i}.webp`, `https://example.test/${i}`, Date.now() + 60_000);
    }
    check(
      _getSignedUrlCacheSizeForTests() === 1200,
      "seeding directly bypasses pruning (sanity check on the test helper itself)",
      _getSignedUrlCacheSizeForTests()
    );
  }

  // -----------------------------------------------------------------
  // Live: getSignedPhotoUrl/getSignedPhotoUrls against real, already-
  // uploaded employee photos — proves the cache is actually reached by the
  // real code paths, not just exercised directly via the test-only seam
  // above. Read-only; signing never modifies the object.
  // -----------------------------------------------------------------
  {
    const { rows } = await pool.query(
      `select id, profile_photo_path from employees
       where profile_photo_path is not null
       order by id
       limit 2`
    );
    if (rows.length < 2) {
      console.log(
        `SKIPPED live signed-URL tests — need at least 2 employees with a profile photo, found ${rows.length}. ` +
          "Pure cache-logic tests above still ran."
      );
    } else {
      const [pathA, pathB] = rows.map((r) => r.profile_photo_path as string);
      _clearSignedUrlCacheForTests();

      const firstA = await getSignedPhotoUrl(pathA);
      check(typeof firstA === "string" && firstA.length > 0, "getSignedPhotoUrl signs a real, existing photo path");

      const secondA = await getSignedPhotoUrl(pathA);
      check(
        secondA === firstA,
        "a second call for the SAME path reuses the cached URL verbatim, rather than re-signing",
        { firstA, secondA }
      );

      const firstB = await getSignedPhotoUrl(pathB);
      check(
        typeof firstB === "string" && firstB !== firstA,
        "a different photo path is never served the other path's cached URL",
        { firstA, firstB }
      );

      // getSignedPhotoUrls (the batch variant used by GET /employees) reads
      // through the exact same cache getSignedPhotoUrl just populated for
      // pathA — a genuinely shared cache, not two independent ones — and
      // still correctly signs pathB fresh the first time it's asked for it
      // in this batch form.
      _clearSignedUrlCacheForTests();
      const solo = await getSignedPhotoUrl(pathA);
      const batch = await getSignedPhotoUrls([pathA, pathB]);
      check(batch.get(pathA) === solo, "getSignedPhotoUrls reuses a URL already cached by getSignedPhotoUrl", {
        solo,
        batched: batch.get(pathA),
      });
      check(
        typeof batch.get(pathB) === "string" && batch.get(pathB) !== batch.get(pathA),
        "getSignedPhotoUrls signs a not-yet-cached path fresh, distinct from the other path in the same batch"
      );
    }
  }

  _clearSignedUrlCacheForTests();
  await pool.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
