import { createClient, SupabaseClient } from "@supabase/supabase-js";

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "employee-profile-photos";

let client: SupabaseClient | null = null;
let bucketEnsured = false;

// In-memory signed-URL cache, keyed by the complete storage path — best
// effort and per-instance only (no cross-instance/Redis sync). Railway can
// run more than one instance; each signs and caches its own copy
// independently, which just means a cold instance re-signs once, the same
// uncached cost every request used to pay. Diagnosed as the single most
// expensive step in GET /api/inputs/daily (a real Supabase Storage API
// call, ~100-500ms, previously repeated on every load AND every 10s
// background poll even though the URL it produces stays valid for a full
// hour) — see the Inputs employee-switch performance investigation.
//
// The cache TTL is kept well under the URL's own real expiresInSeconds
// (75%, i.e. 45 of every 60 minutes) so a cached entry is always re-signed
// with time to spare rather than ever being handed out already-expired or
// expiring mid-use. Keyed by path alone (not path+expiresInSeconds): every
// caller today always requests the same default expiry, so this is safe;
// a future caller that deliberately needs a different expiry would need to
// bypass the cache or key it more specifically.
interface CachedSignedUrl {
  url: string;
  expiresAt: number; // Date.now() at cache time, plus the TTL margin above
}
const CACHE_TTL_FRACTION = 0.75;
// Backstop against unbounded growth if many distinct employees' photos get
// signed within one TTL window (every employee in a search result, say) —
// prune expired entries opportunistically on every write, and if that alone
// isn't enough, drop the oldest (first-inserted) entries down to this cap.
// Comfortably above any realistic employee-photo count for this app.
const SIGNED_URL_CACHE_MAX_ENTRIES = 1000;

const signedUrlCache = new Map<string, CachedSignedUrl>();

function getCachedSignedUrl(path: string): string | null {
  const cached = signedUrlCache.get(path);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    signedUrlCache.delete(path);
    return null;
  }
  return cached.url;
}

function setCachedSignedUrl(path: string, url: string, expiresInSeconds: number): void {
  signedUrlCache.set(path, { url, expiresAt: Date.now() + expiresInSeconds * 1000 * CACHE_TTL_FRACTION });
  pruneSignedUrlCache();
}

function pruneSignedUrlCache(): void {
  const now = Date.now();
  for (const [path, entry] of signedUrlCache) {
    if (entry.expiresAt <= now) signedUrlCache.delete(path);
  }
  if (signedUrlCache.size <= SIGNED_URL_CACHE_MAX_ENTRIES) return;
  // Map iterates in insertion order — the first keys visited are the
  // oldest (soonest-to-expire, since every entry uses the same TTL
  // fraction), so dropping from the front is the same "prune what's least
  // fresh" policy as time-based expiry would eventually apply anyway.
  const excess = signedUrlCache.size - SIGNED_URL_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const path of signedUrlCache.keys()) {
    if (removed >= excess) break;
    signedUrlCache.delete(path);
    removed++;
  }
}

// Exposed for tests only — production code never needs to reset this
// between requests; each process keeps one cache for its whole lifetime.
export function _clearSignedUrlCacheForTests(): void {
  signedUrlCache.clear();
}

// Test-only seam for exercising expiry/pruning deterministically, without
// waiting out the real TTL or making real Supabase calls — lets a test
// assert "an entry past its expiresAt is never returned" and "the cache
// stays bounded" as pure logic, independent of the network call around it.
export function _setCachedSignedUrlForTests(path: string, url: string, expiresAt: number): void {
  signedUrlCache.set(path, { url, expiresAt });
}

export function _getSignedUrlCacheSizeForTests(): number {
  return signedUrlCache.size;
}

export function _getCachedSignedUrlForTests(path: string): string | null {
  return getCachedSignedUrl(path);
}

// Service-role key never reaches the browser — this module (and everything
// that imports it) only ever runs server-side. All employee-photo storage
// operations are gated by the route-level Administrator auth check before
// any of these functions are called.
function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use employee photo storage"
    );
  }

  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return client;
}

async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const supabase = getClient();

  const { data: existing, error: listErr } = await supabase.storage.getBucket(BUCKET);
  if (listErr && !existing) {
    const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: "5MB",
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    });
    // A concurrent request may have created it between the check and here —
    // that's success, not a failure.
    if (createErr && !/already exists/i.test(createErr.message)) {
      throw new Error(`Could not create storage bucket "${BUCKET}": ${createErr.message}`);
    }
  }
  bucketEnsured = true;
}

export async function uploadEmployeePhoto(
  employeeId: string,
  objectId: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  await ensureBucket();
  const path = `employees/${employeeId}/${objectId}.webp`;

  const { error } = await getClient()
    .storage.from(BUCKET)
    .upload(path, buffer, { contentType, upsert: false });
  if (error) {
    throw new Error(`Photo upload failed: ${error.message}`);
  }
  return path;
}

export async function deleteEmployeePhoto(path: string): Promise<void> {
  const { error } = await getClient().storage.from(BUCKET).remove([path]);
  if (error) {
    // Best-effort cleanup — a missing/already-gone object shouldn't fail the
    // caller's request (e.g. replacing a photo whose old file was already
    // removed some other way).
    console.error(`Failed to delete storage object ${path}:`, error.message);
  }
}

export async function getSignedPhotoUrl(
  path: string,
  expiresInSeconds = 3600
): Promise<string | null> {
  const cached = getCachedSignedUrl(path);
  if (cached) return cached;

  const { data, error } = await getClient()
    .storage.from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data) {
    console.error(`Failed to sign URL for ${path}:`, error?.message);
    return null;
  }
  setCachedSignedUrl(path, data.signedUrl, expiresInSeconds);
  return data.signedUrl;
}

// Batch variant for list views — one Storage API call for whichever paths
// aren't already cached, instead of N, the same reasoning as avoiding N+1
// DB queries. A path already cached (e.g. an employee whose photo GET
// /daily already signed moments earlier) is served from the same cache
// getSignedPhotoUrl populates — one shared cache, not two.
export async function getSignedPhotoUrls(
  paths: string[],
  expiresInSeconds = 3600
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (paths.length === 0) return map;

  const uncached: string[] = [];
  for (const path of paths) {
    const cached = getCachedSignedUrl(path);
    if (cached) map.set(path, cached);
    else uncached.push(path);
  }
  if (uncached.length === 0) return map;

  const { data, error } = await getClient()
    .storage.from(BUCKET)
    .createSignedUrls(uncached, expiresInSeconds);
  if (error || !data) {
    console.error("Failed to batch-sign photo URLs:", error?.message);
    return map;
  }
  for (const entry of data) {
    if (entry.signedUrl && !entry.error && entry.path) {
      map.set(entry.path, entry.signedUrl);
      setCachedSignedUrl(entry.path, entry.signedUrl, expiresInSeconds);
    }
  }
  return map;
}
