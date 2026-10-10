import type { ScannedTag } from "./nfc";
import type { ResolvedTagTarget } from "./nfcMappingCache";
import type { RowPickerLand } from "../components/mobile/RowPickerSheet";

// Pure decisions for the iPhone Write New Tag flow (IosWriteNewTagScreen).

export type TagWriteTarget = { targetType: "greenhouse_row" | "carrier"; targetId: string; label: string };

export type PreWriteCheck =
  | { kind: "write" }
  | { kind: "read-only" }
  // Already carries an assignment for exactly this row/bin — nothing to do.
  | { kind: "already-this-target"; label: string }
  // Assigned to a different row/bin. Writing would silently break that
  // assignment, so the flow stops and says so.
  | { kind: "assigned-elsewhere"; label: string };

export function checkTagBeforeWrite(tag: ScannedTag, target: TagWriteTarget, existing: ResolvedTagTarget | null): PreWriteCheck {
  if (tag.isWritable === false) return { kind: "read-only" };
  // Capacity is checked against the real record by writeTag() and again by
  // the native plugin before writing.
  if (existing) {
    if (existing.targetType === target.targetType && existing.targetId === target.targetId) {
      return { kind: "already-this-target", label: existing.label };
    }
    return { kind: "assigned-elsewhere", label: existing.label };
  }
  return { kind: "write" };
}

// Same "<phase> · Row <n>" label the server uses for mappings
// (server/src/lib/nfcTagResolution.ts targetLabelSelect), so an offline
// assignment reads identically before and after it syncs.
export function rowTargetLabel(lands: RowPickerLand[] | null, rowId: string): string {
  for (const land of lands ?? []) {
    for (const phase of land.phases) {
      const row = phase.rows.find((r) => r.id === rowId);
      if (row) return `${phase.name} · Row ${row.rowNumber}`;
    }
  }
  return "Selected row";
}
