// Shared shape for a single NFC tag mapping as the admin registration/
// writing screens see it (conflict payloads from POST /register and
// /write-mapping — see server/src/lib/nfcTagResolution.ts's TagMapping).
// Deliberately separate from nfcMappingCache.ts's CachedTagMapping, which is
// the narrower shape the offline scan-resolution cache actually persists.
export interface TagMapping {
  id: string;
  targetType: "greenhouse_row" | "carrier";
  targetId: string;
  label: string;
  tagKind: "labourlink" | "ridder";
  labourlinkTagUuid: string | null;
  ridderHardwareId: string | null;
}
