// Tag assignments this phone has written (Write New Tag on iPhone) but the
// server hasn't confirmed yet — so a tag written offline in a greenhouse can
// be scanned and used on this phone straight away, then registered once the
// phone reconnects (lib/pendingTagSync.ts). No imports on purpose:
// nfcMappingCache.ts reads it to resolve scans, and pendingTagSync.ts
// (which imports nfcMappingCache) writes it.
//
// localStorage, same as the downloaded mapping cache and the device identity
// it belongs with (Library/WebKit is excluded from backups — AppDelegate).

const KEY = "labourlink_pending_tag_registrations";

export type PendingTagStatus =
  // Written and verified on the tag; waiting to be registered.
  | "pending"
  // The server says this row/bin already has a different tag. Nothing is
  // replaced until an admin chooses (resolvePendingTagConflict).
  | "conflict"
  // Registration can't succeed as-is (e.g. the tag ID is already assigned
  // elsewhere, or the row/bin no longer exists). Kept so it's visible.
  | "failed";

export interface PendingTagConflict {
  label: string | null;
  ridderHardwareId: string | null;
  labourlinkTagUuid: string | null;
}

export interface PendingTagRegistration {
  id: string;
  targetType: "greenhouse_row" | "carrier";
  targetId: string;
  label: string;
  labourlinkTagUuid: string; // lowercase
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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(entries: PendingTagRegistration[]): void {
  localStorage.setItem(KEY, JSON.stringify(entries));
  listeners.forEach((l) => l());
}

export function addPendingTag(entry: PendingTagRegistration): void {
  save([...listPendingTags().filter((e) => e.id !== entry.id), { ...entry, labourlinkTagUuid: entry.labourlinkTagUuid.toLowerCase() }]);
}

export function updatePendingTag(id: string, patch: Partial<PendingTagRegistration>): void {
  save(listPendingTags().map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

export function removePendingTag(id: string): void {
  save(listPendingTags().filter((e) => e.id !== id));
}

// Assignments this phone should resolve scans against right now. A
// "conflict" entry still resolves locally — the tag physically carries this
// row/bin's ID; only the server-side registration is undecided. A "failed"
// entry does not (e.g. its tag ID belongs to something else on the server).
export function localTagMappings(): {
  targetType: "greenhouse_row" | "carrier";
  targetId: string;
  label: string;
  labourlinkTagUuid: string;
  ridderHardwareId: null;
}[] {
  return listPendingTags()
    .filter((e) => e.status === "pending" || e.status === "conflict")
    .map((e) => ({ targetType: e.targetType, targetId: e.targetId, label: e.label, labourlinkTagUuid: e.labourlinkTagUuid, ridderHardwareId: null }));
}
