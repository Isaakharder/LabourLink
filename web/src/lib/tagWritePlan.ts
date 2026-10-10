import type { ScannedTag } from "./nfc";
import type { ResolvedTagTarget } from "./nfcMappingCache";
import type { RowPickerLand } from "../components/mobile/RowPickerSheet";
import { LABOURLINK_URI_PREFIX } from "./nfc";

// Pure decisions for iPhone "Set Up NFC Tag" (IosNfcSetupScreen).

export type TagTargetType = "greenhouse_row" | "carrier" | "activity" | "action";
export type TagWriteTarget = { targetType: TagTargetType; targetId: string; label: string };

export const ACTION_LABELS: Record<"start_break" | "end_break" | "end_work", string> = {
  start_break: "Start Break",
  end_break: "End Break",
  end_work: "End Work",
};

// "as-is": register the tag's existing ID without writing to it (works for
// read-only tags). "write": write a new LabourLink tag ID (writable tags only).
export type AssignMode = "as-is" | "write";

export type AssignPlan =
  // Already carries an assignment for exactly this target — nothing to do.
  | { kind: "already-this-target"; label: string }
  // Assigned to something else. Never silently replaced or overwritten.
  | { kind: "assigned-elsewhere"; label: string }
  | { kind: "read-only" } // write mode on a read-only tag
  | { kind: "no-identifier" } // as-is mode, but the tag exposes no usable ID
  | { kind: "register-uuid"; labourlinkTagUuid: string } // as-is: tag already carries a (free) LabourLink ID
  | { kind: "register-hardware"; ridderHardwareId: string } // as-is: by hardware ID
  | { kind: "write" };

export function planAssign(tag: ScannedTag, target: TagWriteTarget, existing: ResolvedTagTarget | null, mode: AssignMode): AssignPlan {
  if (existing) {
    if (existing.targetType === target.targetType && existing.targetId === target.targetId) {
      return { kind: "already-this-target", label: existing.label };
    }
    return { kind: "assigned-elsewhere", label: existing.label };
  }
  if (mode === "write") {
    // Capacity is checked against the real record by writeTag() and again by
    // the native plugin before writing.
    return tag.isWritable === false ? { kind: "read-only" } : { kind: "write" };
  }
  if (tag.labourlinkTagUuid) return { kind: "register-uuid", labourlinkTagUuid: tag.labourlinkTagUuid.toLowerCase() };
  if (tag.hardwareId) return { kind: "register-hardware", ridderHardwareId: tag.hardwareId.toUpperCase() };
  return { kind: "no-identifier" };
}

// Back-compat for build-15 callers.
export function checkTagBeforeWrite(
  tag: ScannedTag,
  target: TagWriteTarget,
  existing: ResolvedTagTarget | null
): { kind: "write" } | { kind: "read-only" } | { kind: "already-this-target"; label: string } | { kind: "assigned-elsewhere"; label: string } {
  const plan = planAssign(tag, target, existing, "write");
  return plan.kind === "write" || plan.kind === "read-only" || plan.kind === "already-this-target" || plan.kind === "assigned-elsewhere"
    ? plan
    : { kind: "write" };
}

// Clear Tag. Removing the LabourLink assignment and erasing the physical
// contents are separate results — a read-only tag can be unassigned but not
// erased; an unassigned tag can still be erased.
export type ClearPlan = {
  unassign: { target: ResolvedTagTarget; labourlinkTagUuid: string | null; ridderHardwareId: string | null } | null;
  erase: "erase" | "read-only" | "not-requested";
};

export function planClear(
  tag: ScannedTag,
  assignment: ClearPlan["unassign"],
  eraseRequested: boolean
): ClearPlan {
  return {
    unassign: assignment,
    erase: !eraseRequested ? "not-requested" : tag.isWritable === false ? "read-only" : "erase",
  };
}

// Custom Text / URL. Never written over an assigned (active) LabourLink tag.
export type CustomPlan = { kind: "write" } | { kind: "assigned"; label: string } | { kind: "read-only" };
export function planCustomWrite(tag: ScannedTag, existing: ResolvedTagTarget | null): CustomPlan {
  if (existing) return { kind: "assigned", label: existing.label };
  if (tag.isWritable === false) return { kind: "read-only" };
  return { kind: "write" };
}

// Returns an error message, or null when the content is acceptable.
export function validateCustomContent(kind: "text" | "url", value: string): string | null {
  const v = value.trim();
  if (!v) return kind === "url" ? "Enter a URL." : "Enter some text.";
  if (v.length > 200) return "Keep it under 200 characters so it fits on common tags.";
  if (v.toLowerCase().includes(LABOURLINK_URI_PREFIX.toLowerCase())) {
    return "This content looks like a LabourLink tag ID. Use Rows, Bins, Activities or an action instead.";
  }
  if (kind === "url") {
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      return "Enter a full URL, starting with https://";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return "Only http:// and https:// URLs can be written.";
  }
  return null;
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
