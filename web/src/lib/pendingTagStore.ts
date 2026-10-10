// Tag operations this phone has made (Set Up NFC Tag on iPhone) that the
// server hasn't confirmed yet — so a tag set up or cleared offline in a
// greenhouse takes effect on this phone immediately and survives a restart,
// then syncs once the phone reconnects (lib/pendingTagSync.ts), oldest first.
// No imports on purpose: nfcMappingCache.ts reads it to resolve scans, and
// pendingTagSync.ts (which imports nfcMappingCache) writes it.
//
// localStorage, same as the downloaded mapping cache and the device identity
// it belongs with (Library/WebKit is excluded from backups — AppDelegate).

const KEY = "labourlink_pending_tag_registrations";

export type TagTargetKind = "greenhouse_row" | "carrier" | "activity" | "action";

export type PendingTagStatus =
  // Waiting to be sent.
  | "pending"
  // Assign only: the server says this row/bin already has a different tag
  // (or the tag belongs to something else). Nothing is replaced until an
  // admin chooses (resolvePendingTagConflict).
  | "conflict"
  // Can't succeed as-is (tag ID used elsewhere, target gone, assignment
  // changed by someone else before a removal arrived…). Kept so it's visible.
  | "failed";

export interface PendingTagConflict {
  label: string | null;
  ridderHardwareId: string | null;
  labourlinkTagUuid: string | null;
}

export interface PendingTagRegistration {
  id: string;
  // "assign" (default for entries saved by build 15) or "unassign" (Clear Tag).
  op?: "assign" | "unassign";
  // For "unassign": the target the phone believed the tag was assigned to —
  // the server only removes it if that's still true.
  targetType: TagTargetKind;
  targetId: string;
  label: string;
  // Exactly one identifier: a LabourLink tag ID written by the app, or the
  // tag's hardware ID (a tag registered as it is — incl. read-only tags).
  labourlinkTagUuid: string | null; // lowercase
  ridderHardwareId?: string | null; // uppercase hex
  writtenAt: string;
  status: PendingTagStatus;
  attempts: number;
  lastError: string | null;
  conflict: PendingTagConflict | null;
  // Set only when an admin explicitly chose "Replace" on a conflict.
  confirmReplaceTarget: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribePendingTags(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listPendingTags(): PendingTagRegistration[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.map((e) => ({ op: "assign", ridderHardwareId: null, ...e })) : [];
  } catch {
    return [];
  }
}

function save(entries: PendingTagRegistration[]): void {
  localStorage.setItem(KEY, JSON.stringify(entries));
  listeners.forEach((l) => l());
}

export function addPendingTag(entry: PendingTagRegistration): void {
  const key = identifierKey(entry);
  save([
    // Clearing a tag drops this phone's own assign for it that the server
    // never accepted (a conflict) — otherwise it would keep resolving. A
    // "pending" assign may already have reached the server, so it stays and
    // syncs first; the removal follows it.
    ...listPendingTags().filter(
      (e) => e.id !== entry.id && !(entry.op === "unassign" && e.op !== "unassign" && e.status === "conflict" && identifierKey(e) === key)
    ),
    {
      ...entry,
      op: entry.op ?? "assign",
      labourlinkTagUuid: entry.labourlinkTagUuid ? entry.labourlinkTagUuid.toLowerCase() : null,
      ridderHardwareId: entry.ridderHardwareId ? entry.ridderHardwareId.toUpperCase() : null,
    },
  ]);
}

export function updatePendingTag(id: string, patch: Partial<PendingTagRegistration>): void {
  save(listPendingTags().map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

export function removePendingTag(id: string): void {
  save(listPendingTags().filter((e) => e.id !== id));
}

export function identifierKey(e: { labourlinkTagUuid?: string | null; ridderHardwareId?: string | null }): string {
  return e.labourlinkTagUuid ? `uuid:${e.labourlinkTagUuid.toLowerCase()}` : `hw:${(e.ridderHardwareId ?? "").toUpperCase()}`;
}

export interface LocalTagMapping {
  targetType: TagTargetKind;
  targetId: string;
  label: string;
  labourlinkTagUuid: string | null;
  ridderHardwareId: string | null;
}

// What this phone's own queued operations say right now, per tag: the
// LATEST operation for a tag wins. An assign makes the tag resolve locally
// (a "conflict" assign still does — the tag physically carries this target;
// only the server side is undecided). A pending unassign hides that tag's
// cached assignment until the server confirms the removal, so a cache refresh
// can't bring it back. "failed" operations have no local effect.
export function localTagState(): { mappings: LocalTagMapping[]; suppressed: Set<string> } {
  const latest = new Map<string, PendingTagRegistration>();
  for (const e of [...listPendingTags()].sort((a, b) => a.writtenAt.localeCompare(b.writtenAt))) {
    if (e.status === "failed") continue;
    latest.set(identifierKey(e), e);
  }
  const mappings: LocalTagMapping[] = [];
  const suppressed = new Set<string>();
  for (const [key, e] of latest) {
    if (e.op === "unassign") {
      if (e.status === "pending") suppressed.add(key);
    } else {
      suppressed.add(key); // the local assignment supersedes any cached one for this tag
      mappings.push({
        targetType: e.targetType,
        targetId: e.targetId,
        label: e.label,
        labourlinkTagUuid: e.labourlinkTagUuid,
        ridderHardwareId: e.ridderHardwareId ?? null,
      });
    }
  }
  return { mappings, suppressed };
}

// Back-compat helper (build 15 callers/tests).
export function localTagMappings(): LocalTagMapping[] {
  return localTagState().mappings;
}
