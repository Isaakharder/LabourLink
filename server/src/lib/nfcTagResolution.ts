// Shared query logic for NFC tag <-> row/bin ("bin" = the existing Carrier
// concept — no separate bins table exists) mappings, used by
// server/src/routes/nfcTags.ts. Extracted the same way activitySelection.ts
// is, so the conflict checks the register/write-mapping routes rely on stay
// in one place rather than drifting between call sites.
import { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

// "activity": start/switch to that job. "action": a fixed work action (see
// TAG_ACTIONS). Rows/carriers allow one active tag per target; activities
// and actions may have several (migration 062).
export type TargetType = "greenhouse_row" | "carrier" | "activity" | "action";
export const LEGACY_TARGET_TYPES: readonly TargetType[] = ["greenhouse_row", "carrier"];
export const TAG_ACTIONS = ["start_break", "end_break", "end_work"] as const;
export type TagAction = (typeof TAG_ACTIONS)[number];
export function isTagAction(v: unknown): v is TagAction {
  return typeof v === "string" && (TAG_ACTIONS as readonly string[]).includes(v);
}
// Only rows and carriers are limited to one active tag per target.
export function targetAllowsSingleTag(targetType: TargetType): boolean {
  return targetType === "greenhouse_row" || targetType === "carrier";
}

export interface TagMapping {
  id: string;
  targetType: TargetType;
  targetId: string;
  label: string;
  tagKind: "labourlink" | "ridder";
  labourlinkTagUuid: string | null;
  ridderHardwareId: string | null;
}

// Ridder hardware IDs are always stored/compared in normalized uppercase
// hex, matching lib/nfc.ts's hexId() on the client and the DB's own
// chk_nfc_tag_mappings_ridder_id_uppercase check constraint — a mismatch in
// case here would silently fail to find a mapping that visibly exists.
export function normalizeHardwareId(id: string): string {
  return id.trim().toUpperCase();
}

function targetLabelSelect(): string {
  // Row label matches the exact convention already used for an in-progress
  // entry's location (mobileTime.ts's serializeStatus): "<phase> · Row <n>".
  // Carrier label is just its name, same as CarrierPickerSheet already shows.
  return `
    coalesce(
      (select gp.name || ' · Row ' || gr.row_number
       from greenhouse_rows gr join greenhouse_phases gp on gp.id = gr.phase_id
       where gr.id = m.greenhouse_row_id),
      (select c.name from carriers c where c.id = m.carrier_id),
      (select a.name from activities a where a.id = m.activity_id),
      case m.action when 'start_break' then 'Start Break' when 'end_break' then 'End Break' when 'end_work' then 'End Work' end
    ) as label
  `;
}

function toMapping(row: {
  id: string;
  greenhouse_row_id: string | null;
  carrier_id: string | null;
  activity_id: string | null;
  action: string | null;
  label: string;
  tag_kind: "labourlink" | "ridder";
  labourlink_tag_uuid: string | null;
  ridder_hardware_id: string | null;
}): TagMapping {
  return {
    id: row.id,
    targetType: row.greenhouse_row_id
      ? "greenhouse_row"
      : row.carrier_id
        ? "carrier"
        : row.activity_id
          ? "activity"
          : "action",
    targetId: (row.greenhouse_row_id ?? row.carrier_id ?? row.activity_id ?? row.action) as string,
    label: row.label,
    tagKind: row.tag_kind,
    labourlinkTagUuid: row.labourlink_tag_uuid,
    ridderHardwareId: row.ridder_hardware_id,
  };
}

export async function findActiveMappingByIdentifier(
  db: Queryable,
  identifier: { labourlinkTagUuid: string } | { ridderHardwareId: string }
): Promise<TagMapping | null> {
  const { rows } = await db.query(
    `select m.id, m.greenhouse_row_id, m.carrier_id, m.activity_id, m.action, m.tag_kind, m.labourlink_tag_uuid, m.ridder_hardware_id,
            ${targetLabelSelect()}
     from nfc_tag_mappings m
     where m.deactivated_at is null
       and ${"labourlinkTagUuid" in identifier ? "m.labourlink_tag_uuid = $1" : "m.ridder_hardware_id = $1"}`,
    ["labourlinkTagUuid" in identifier ? identifier.labourlinkTagUuid : normalizeHardwareId(identifier.ridderHardwareId)]
  );
  return rows[0] ? toMapping(rows[0]) : null;
}

// The single active tag of a row/carrier. Activities and actions can have
// several tags, so they never have a "target conflict" — returns null.
export async function findActiveMappingByTarget(
  db: Queryable,
  target: { targetType: TargetType; targetId: string }
): Promise<TagMapping | null> {
  if (!targetAllowsSingleTag(target.targetType)) return null;
  const { rows } = await db.query(
    `select m.id, m.greenhouse_row_id, m.carrier_id, m.activity_id, m.action, m.tag_kind, m.labourlink_tag_uuid, m.ridder_hardware_id,
            ${targetLabelSelect()}
     from nfc_tag_mappings m
     where m.deactivated_at is null
       and ${target.targetType === "greenhouse_row" ? "m.greenhouse_row_id = $1" : "m.carrier_id = $1"}`,
    [target.targetId]
  );
  return rows[0] ? toMapping(rows[0]) : null;
}

// Every active mapping — the full list an employee's device caches for
// offline scan resolution (GET /api/mobile/tags/mappings). No role check:
// any paired device needs this to resolve a scan, not just admins.
// includeAll=false (what pre-062 clients get) returns only row/carrier
// mappings: an old client that saw an activity/action mapping would treat
// it as a carrier.
export async function listActiveMappings(db: Queryable, options: { includeAll?: boolean } = {}): Promise<TagMapping[]> {
  const { rows } = await db.query(
    `select m.id, m.greenhouse_row_id, m.carrier_id, m.activity_id, m.action, m.tag_kind, m.labourlink_tag_uuid, m.ridder_hardware_id,
            ${targetLabelSelect()}
     from nfc_tag_mappings m
     where m.deactivated_at is null
       ${options.includeAll ? "" : "and (m.greenhouse_row_id is not null or m.carrier_id is not null)"}`
  );
  return rows.map(toMapping);
}

export async function deactivateMapping(
  db: Queryable,
  mappingId: string,
  deactivatedByEmployeeId: string
): Promise<void> {
  await db.query(`update nfc_tag_mappings set deactivated_at = now(), deactivated_by_employee_id = $1 where id = $2`, [
    deactivatedByEmployeeId,
    mappingId,
  ]);
}
