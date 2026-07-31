import { createClient, SupabaseClient } from "@supabase/supabase-js";

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "employee-profile-photos";

let client: SupabaseClient | null = null;
let bucketEnsured = false;

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
  const { data, error } = await getClient()
    .storage.from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data) {
    console.error(`Failed to sign URL for ${path}:`, error?.message);
    return null;
  }
  return data.signedUrl;
}

// Batch variant for list views — one Storage API call for N employees
// instead of N, the same reasoning as avoiding N+1 DB queries.
export async function getSignedPhotoUrls(
  paths: string[],
  expiresInSeconds = 3600
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (paths.length === 0) return map;

  const { data, error } = await getClient()
    .storage.from(BUCKET)
    .createSignedUrls(paths, expiresInSeconds);
  if (error || !data) {
    console.error("Failed to batch-sign photo URLs:", error?.message);
    return map;
  }
  for (const entry of data) {
    if (entry.signedUrl && !entry.error) map.set(entry.path ?? "", entry.signedUrl);
  }
  return map;
}
