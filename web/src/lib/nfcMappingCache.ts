import { api } from "./api";
import { ScannedTag } from "./nfc";
import { identifierKey, localTagState, TagTargetKind } from "./pendingTagStore";
import { isIosNativePlatform } from "./platform";

// Offline-first cache of every active NFC tag mapping. Fetched from GET
// /api/mobile/tags/mappings and refreshed the same event-driven way
// loadGreenhouseRows/loadActivities already are (mount, reconnect, foreground
// — see HomeScreen.tsx), then persisted to localStorage so a scan resolves
// identically whether the phone is online or not: there is deliberately no
// separate "live resolve" server call on the scan path itself, only this
// cache lookup.
//
// iPhone asks for every kind (?include=all: rows, bins, activities, actions);
// Android keeps the row/bin-only list it always had (its scan handling only
// knows rows and bins).
const CACHE_KEY = "labourlink_nfc_tag_mappings_cache";

export type TagMappingTargetType = TagTargetKind;
export type TagAction = "start_break" | "end_break" | "end_work";

export interface CachedTagMapping {
  targetType: TagMappingTargetType;
  targetId: string;
  label: string;
  labourlinkTagUuid: string | null;
  ridderHardwareId: string | null;
}

export interface ResolvedTagTarget {
  targetType: TagMappingTargetType;
  targetId: string;
  label: string;
}

export async function refreshTagMappingCache(): Promise<void> {
  const result = await api<{ mappings: CachedTagMapping[] }>(
    `/api/mobile/tags/mappings${isIosNativePlatform() ? "?include=all" : ""}`
  );
  // Never replace the saved list with something that isn't one — scanning
  // offline depends on it.
  if (!Array.isArray(result?.mappings)) throw new Error("Unexpected tag mappings response");
  localStorage.setItem(CACHE_KEY, JSON.stringify(result.mappings));
}

export function getCachedTagMappings(): CachedTagMapping[] {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function findMapping(tag: ScannedTag, mappings: CachedTagMapping[]): CachedTagMapping | null {
  if (tag.labourlinkTagUuid) {
    const uuid = tag.labourlinkTagUuid.toLowerCase();
    const byUuid = mappings.find((m) => m.labourlinkTagUuid?.toLowerCase() === uuid);
    if (byUuid) return byUuid;
  }
  if (!tag.hardwareId) return null;
  const hw = tag.hardwareId.toUpperCase();
  return mappings.find((m) => m.ridderHardwareId?.toUpperCase() === hw) ?? null;
}

// Pure — takes the mapping list explicitly rather than reading localStorage
// itself, so this is directly unit-testable. Resolution order: a valid
// parsed LabourLink NDEF UUID wins if present and mapped; otherwise fall
// back to the tag's hardware ID (normalized uppercase, matching how every
// hardwareId is stored — see hexId() in lib/nfc.ts and the server's
// normalizeHardwareId()). Returns null for an unrecognized tag — the caller
// always falls back to manual selection in that case, never an error state
// that blocks the picker.
export function resolveTagAgainstMappings(tag: ScannedTag, mappings: CachedTagMapping[]): ResolvedTagTarget | null {
  const m = findMapping(tag, mappings);
  return m ? { targetType: m.targetType, targetId: m.targetId, label: m.label } : null;
}

// The mappings a scan should be resolved against right now: this phone's own
// queued assignments first, then the downloaded cache minus any tag with a
// newer local operation (a pending removal, or a local re-assignment).
export function effectiveTagMappings(): CachedTagMapping[] {
  const { mappings: local, suppressed } = localTagState();
  return [...local, ...getCachedTagMappings().filter((m) => !suppressed.has(identifierKey(m)))];
}

export function resolveScannedTag(tag: ScannedTag): ResolvedTagTarget | null {
  return resolveTagAgainstMappings(tag, effectiveTagMappings());
}

// Which assignment a scanned tag currently has, and through which of its
// identifiers (Clear Tag needs to remove exactly that one).
export function findTagAssignment(
  tag: ScannedTag
): { target: ResolvedTagTarget; labourlinkTagUuid: string | null; ridderHardwareId: string | null } | null {
  const m = findMapping(tag, effectiveTagMappings());
  if (!m) return null;
  return {
    target: { targetType: m.targetType, targetId: m.targetId, label: m.label },
    labourlinkTagUuid: m.labourlinkTagUuid ? m.labourlinkTagUuid.toLowerCase() : null,
    ridderHardwareId: m.labourlinkTagUuid ? null : (m.ridderHardwareId?.toUpperCase() ?? null),
  };
}

// Adds one server-confirmed mapping to the downloaded cache without a full
// refresh (used right after a queued registration succeeds, so there's no
// window where the tag resolves neither locally nor from the cache). A row
// or bin holds one tag, so its previous tag is dropped; activities and
// actions may have several.
export function addToTagMappingCache(mapping: CachedTagMapping): void {
  const singleTagTarget = mapping.targetType === "greenhouse_row" || mapping.targetType === "carrier";
  const key = identifierKey(mapping);
  const others = getCachedTagMappings().filter(
    (m) => identifierKey(m) !== key && !(singleTagTarget && m.targetType === mapping.targetType && m.targetId === mapping.targetId)
  );
  localStorage.setItem(CACHE_KEY, JSON.stringify([...others, mapping]));
}

export function removeFromTagMappingCache(identifier: { labourlinkTagUuid: string | null; ridderHardwareId: string | null }): void {
  const key = identifierKey(identifier);
  localStorage.setItem(CACHE_KEY, JSON.stringify(getCachedTagMappings().filter((m) => identifierKey(m) !== key)));
}
