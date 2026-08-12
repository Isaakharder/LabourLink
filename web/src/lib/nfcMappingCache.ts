import { api } from "./api";
import { ScannedTag } from "./nfc";

// Offline-first cache of every active NFC tag <-> row/bin mapping ("bin" =
// the existing Carrier concept). Fetched from GET /api/mobile/tags/mappings
// and refreshed the same event-driven way loadGreenhouseRows/loadActivities
// already are (mount, reconnect, foreground — see HomeScreen.tsx), then
// persisted to localStorage so a scan resolves identically whether the
// phone is online or not: there is deliberately no separate "live resolve"
// server call on the scan path itself, only this cache lookup.
const CACHE_KEY = "labourlink_nfc_tag_mappings_cache";

export interface CachedTagMapping {
  targetType: "greenhouse_row" | "carrier";
  targetId: string;
  label: string;
  labourlinkTagUuid: string | null;
  ridderHardwareId: string | null;
}

export interface ResolvedTagTarget {
  targetType: "greenhouse_row" | "carrier";
  targetId: string;
  label: string;
}

export async function refreshTagMappingCache(): Promise<void> {
  const result = await api<{
    mappings: { targetType: "greenhouse_row" | "carrier"; targetId: string; label: string; labourlinkTagUuid: string | null; ridderHardwareId: string | null }[];
  }>("/api/mobile/tags/mappings");
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

// Pure — takes the mapping list explicitly rather than reading localStorage
// itself, so this is directly unit-testable. Resolution order: a valid
// parsed LabourLink NDEF UUID wins if present and mapped; otherwise fall
// back to the tag's hardware ID (normalized uppercase, matching how every
// hardwareId is stored — see hexId() in lib/nfc.ts and the server's
// normalizeHardwareId()). Returns null for an unrecognized tag — the caller
// always falls back to manual selection in that case, never an error state
// that blocks the picker.
export function resolveTagAgainstMappings(tag: ScannedTag, mappings: CachedTagMapping[]): ResolvedTagTarget | null {
  if (tag.labourlinkTagUuid) {
    const byUuid = mappings.find((m) => m.labourlinkTagUuid === tag.labourlinkTagUuid);
    if (byUuid) return { targetType: byUuid.targetType, targetId: byUuid.targetId, label: byUuid.label };
  }
  const byHardwareId = mappings.find((m) => m.ridderHardwareId === tag.hardwareId);
  if (byHardwareId) return { targetType: byHardwareId.targetType, targetId: byHardwareId.targetId, label: byHardwareId.label };
  return null;
}

export function resolveScannedTag(tag: ScannedTag): ResolvedTagTarget | null {
  return resolveTagAgainstMappings(tag, getCachedTagMappings());
}
