import { api, ApiError } from "./api";
import { addToTagMappingCache, refreshTagMappingCache } from "./nfcMappingCache";
import { listPendingTags, PendingTagConflict, removePendingTag, updatePendingTag } from "./pendingTagStore";
import { singleFlight } from "./singleFlight";

// Registers tags this phone wrote while offline (lib/pendingTagStore.ts) once
// it can reach the server, oldest first. Never replaces another tag's
// assignment on its own: a conflict waits for an admin's explicit choice
// (resolvePendingTagConflict). POST /api/mobile/tags/write-mapping is
// idempotent for the same tag ID + target, so re-sending after a lost
// response is safe.

const MAPPINGS_REFRESHED_AT_KEY = "labourlink_nfc_mappings_refreshed_at";
const MAPPINGS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export type FlushOutcome = "registered" | "conflict" | "failed" | "unreachable";

// Pure: what a write-mapping error means for a queued registration.
export function classifyRegistrationError(err: unknown): { outcome: Exclude<FlushOutcome, "registered">; message: string; conflict?: PendingTagConflict } {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as { code?: string; error?: string; targetConflict?: Partial<PendingTagConflict> | null };
    const code = err.code ?? body.code;
    if (err.status === 409 && (code === "TARGET_HAS_DIFFERENT_TAG" || body.targetConflict)) {
      const c = body.targetConflict ?? {};
      return {
        outcome: "conflict",
        message: body.error ?? "This row or bin already has a different tag.",
        conflict: { label: c.label ?? null, ridderHardwareId: c.ridderHardwareId ?? null, labourlinkTagUuid: c.labourlinkTagUuid ?? null },
      };
    }
    if (err.status >= 500 || err.status === 0 || err.status === 401) {
      return { outcome: "unreachable", message: body.error ?? err.message };
    }
    // 409 TAG_ID_IN_USE, 400 (row/bin no longer active), 403 (not an admin).
    return { outcome: "failed", message: body.error ?? err.message };
  }
  return { outcome: "unreachable", message: err instanceof Error ? err.message : String(err) };
}

async function registerOne(id: string): Promise<FlushOutcome> {
  const entry = listPendingTags().find((e) => e.id === id);
  if (!entry || entry.status !== "pending") return "failed";
  try {
    await api<{ mappingId: string }>("/api/mobile/tags/write-mapping", {
      method: "POST",
      body: JSON.stringify({
        targetType: entry.targetType,
        targetId: entry.targetId,
        labourlinkTagUuid: entry.labourlinkTagUuid,
        ...(entry.confirmReplaceTarget ? { confirmReplaceTarget: true } : {}),
      }),
    });
    addToTagMappingCache({
      targetType: entry.targetType,
      targetId: entry.targetId,
      label: entry.label,
      labourlinkTagUuid: entry.labourlinkTagUuid,
      ridderHardwareId: null,
    });
    removePendingTag(entry.id);
    return "registered";
  } catch (err) {
    const c = classifyRegistrationError(err);
    if (c.outcome === "unreachable") {
      updatePendingTag(entry.id, { attempts: entry.attempts + 1, lastError: c.message });
    } else {
      updatePendingTag(entry.id, { status: c.outcome, attempts: entry.attempts + 1, lastError: c.message, conflict: c.conflict ?? null });
    }
    return c.outcome;
  }
}

async function doFlush(): Promise<void> {
  if (!navigator.onLine) return;
  let registered = false;
  const queue = listPendingTags()
    .filter((e) => e.status === "pending")
    .sort((a, b) => a.writtenAt.localeCompare(b.writtenAt));
  for (const entry of queue) {
    const outcome = await registerOne(entry.id);
    if (outcome === "registered") registered = true;
    if (outcome === "unreachable") break; // try the rest on the next trigger
  }
  const lastRefresh = Number(localStorage.getItem(MAPPINGS_REFRESHED_AT_KEY) ?? 0);
  if (registered || Date.now() - lastRefresh > MAPPINGS_REFRESH_INTERVAL_MS) {
    try {
      await refreshTagMappingCache();
      localStorage.setItem(MAPPINGS_REFRESHED_AT_KEY, String(Date.now()));
    } catch {
      // Offline/unreachable — keep using what's cached.
    }
  }
}

// Called on every sync trigger (lib/syncEngine.ts). Cheap when nothing is queued.
export const flushPendingTagRegistrations = singleFlight(doFlush);

// Admin's explicit decision on a conflict. "replace" re-sends with
// confirmReplaceTarget (the server deactivates the other tag's assignment);
// "keep" drops this phone's assignment — the physical tag keeps its new ID
// but stays unregistered.
export async function resolvePendingTagConflict(id: string, choice: "replace" | "keep"): Promise<FlushOutcome | "removed"> {
  if (choice === "keep") {
    removePendingTag(id);
    return "removed";
  }
  updatePendingTag(id, { status: "pending", confirmReplaceTarget: true, lastError: null });
  if (!navigator.onLine) return "unreachable";
  return registerOne(id);
}
