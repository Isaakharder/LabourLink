import { api, ApiError } from "./api";
import { addToTagMappingCache, refreshTagMappingCache, removeFromTagMappingCache } from "./nfcMappingCache";
import { listPendingTags, PendingTagConflict, PendingTagRegistration, removePendingTag, updatePendingTag } from "./pendingTagStore";
import { singleFlight } from "./singleFlight";

// Sends tag operations this phone made offline (lib/pendingTagStore.ts) once
// it can reach the server, oldest first:
//   assign by LabourLink tag ID -> POST /api/mobile/tags/write-mapping
//   assign by hardware ID       -> POST /api/mobile/tags/register
//   unassign (Clear Tag)        -> POST /api/mobile/tags/unassign
// Never replaces another assignment on its own: a conflict waits for an
// admin's explicit choice (resolvePendingTagConflict). Every route is
// idempotent for a retried operation, so re-sending after a lost response is
// safe; an unassign only removes the assignment the phone expected.

const MAPPINGS_REFRESHED_AT_KEY = "labourlink_nfc_mappings_refreshed_at";
const MAPPINGS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export type FlushOutcome = "registered" | "conflict" | "failed" | "unreachable";

// Pure: what a tag-route error means for a queued operation.
export function classifyRegistrationError(err: unknown): { outcome: Exclude<FlushOutcome, "registered">; message: string; conflict?: PendingTagConflict } {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as {
      code?: string;
      error?: string;
      targetConflict?: Partial<PendingTagConflict> | null;
      tagConflict?: Partial<PendingTagConflict> | null;
    };
    const code = err.code ?? body.code;
    if (
      err.status === 409 &&
      (code === "TARGET_HAS_DIFFERENT_TAG" || code === "TAG_ASSIGNED_ELSEWHERE" || body.targetConflict || body.tagConflict)
    ) {
      const c = body.targetConflict ?? body.tagConflict ?? {};
      return {
        outcome: "conflict",
        message: body.error ?? "This would change an existing tag assignment.",
        conflict: { label: c.label ?? null, ridderHardwareId: c.ridderHardwareId ?? null, labourlinkTagUuid: c.labourlinkTagUuid ?? null },
      };
    }
    if (err.status >= 500 || err.status === 0 || err.status === 401) {
      return { outcome: "unreachable", message: body.error ?? err.message };
    }
    // 409 TAG_ID_IN_USE / ASSIGNMENT_CHANGED, 400 (target no longer active),
    // 403 (not an admin).
    return { outcome: "failed", message: body.error ?? err.message };
  }
  return { outcome: "unreachable", message: err instanceof Error ? err.message : String(err) };
}

async function send(entry: PendingTagRegistration): Promise<void> {
  if (entry.op === "unassign") {
    await api("/api/mobile/tags/unassign", {
      method: "POST",
      body: JSON.stringify({
        ...(entry.labourlinkTagUuid ? { labourlinkTagUuid: entry.labourlinkTagUuid } : { ridderHardwareId: entry.ridderHardwareId }),
        expectedTargetType: entry.targetType,
        expectedTargetId: entry.targetId,
      }),
    });
    return;
  }
  const replace = entry.confirmReplaceTarget ? { confirmReplaceTarget: true } : {};
  if (entry.labourlinkTagUuid) {
    await api("/api/mobile/tags/write-mapping", {
      method: "POST",
      body: JSON.stringify({ targetType: entry.targetType, targetId: entry.targetId, labourlinkTagUuid: entry.labourlinkTagUuid, ...replace }),
    });
  } else {
    await api("/api/mobile/tags/register", {
      method: "POST",
      body: JSON.stringify({
        targetType: entry.targetType,
        targetId: entry.targetId,
        ridderHardwareId: entry.ridderHardwareId,
        // An explicit "Replace" covers both sides of a hardware-ID conflict.
        ...(entry.confirmReplaceTarget ? { confirmReplaceTarget: true, confirmReplaceTag: true } : {}),
      }),
    });
  }
}

async function registerOne(id: string): Promise<FlushOutcome> {
  const entry = listPendingTags().find((e) => e.id === id);
  if (!entry || entry.status !== "pending") return "failed";
  const identifier = { labourlinkTagUuid: entry.labourlinkTagUuid, ridderHardwareId: entry.ridderHardwareId ?? null };
  try {
    await send(entry);
    if (entry.op === "unassign") {
      removeFromTagMappingCache(identifier);
    } else {
      addToTagMappingCache({ targetType: entry.targetType, targetId: entry.targetId, label: entry.label, ...identifier });
    }
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
  let changed = false;
  const queue = listPendingTags()
    .filter((e) => e.status === "pending")
    .sort((a, b) => a.writtenAt.localeCompare(b.writtenAt));
  for (const entry of queue) {
    const outcome = await registerOne(entry.id);
    if (outcome === "registered") changed = true;
    if (outcome === "unreachable") break; // keep order: try the rest on the next trigger
  }
  const lastRefresh = Number(localStorage.getItem(MAPPINGS_REFRESHED_AT_KEY) ?? 0);
  if (changed || Date.now() - lastRefresh > MAPPINGS_REFRESH_INTERVAL_MS) {
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
// confirmReplaceTarget (the server deactivates the other assignment);
// "keep" drops this phone's operation — for a written tag, the physical tag
// keeps its new ID but stays unassigned.
export async function resolvePendingTagConflict(id: string, choice: "replace" | "keep"): Promise<FlushOutcome | "removed"> {
  if (choice === "keep") {
    removePendingTag(id);
    return "removed";
  }
  updatePendingTag(id, { status: "pending", confirmReplaceTarget: true, lastError: null });
  if (!navigator.onLine) return "unreachable";
  return registerOne(id);
}
