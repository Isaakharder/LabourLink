-- Maps a physical NFC tag (either an existing Ridder tag, identified by its
-- stable hardware UID, or a LabourLink-issued tag, identified by the UUID
-- written into its own NDEF record) to a greenhouse row or a carrier
-- ("bin" in farm terminology — no separate bins table exists; see the NFC
-- feature plan). Two nullable FK columns rather than a polymorphic type+id
-- pair, reusing the exact pattern time_entries.greenhouse_row_id/carrier_id
-- already established (015_time_entries_greenhouse_row.sql, 019_carriers.sql).
create table nfc_tag_mappings (
  id uuid primary key default gen_random_uuid(),
  greenhouse_row_id uuid references greenhouse_rows(id),
  carrier_id uuid references carriers(id),
  tag_kind text not null check (tag_kind in ('labourlink', 'ridder')),
  labourlink_tag_uuid uuid,
  ridder_hardware_id text,
  created_at timestamptz not null default now(),
  created_by_employee_id uuid not null references employees(id),
  -- Soft close-old/insert-new on reassignment (never a destructive UPDATE),
  -- the same shape device_assignments.unassigned_at already uses.
  deactivated_at timestamptz,
  deactivated_by_employee_id uuid references employees(id),
  constraint chk_nfc_tag_mappings_exactly_one_target check (
    (greenhouse_row_id is not null and carrier_id is null) or
    (greenhouse_row_id is null and carrier_id is not null)
  ),
  constraint chk_nfc_tag_mappings_identifier_matches_kind check (
    (tag_kind = 'labourlink' and labourlink_tag_uuid is not null and ridder_hardware_id is null) or
    (tag_kind = 'ridder' and ridder_hardware_id is not null and labourlink_tag_uuid is null)
  ),
  -- Hardware IDs are always stored/compared in normalized uppercase hex —
  -- see lib/nfc.ts's hexId() / nfcTagResolution.ts's normalizeHardwareId().
  constraint chk_nfc_tag_mappings_ridder_id_uppercase check (
    ridder_hardware_id is null or ridder_hardware_id = upper(ridder_hardware_id)
  )
);

-- At most one active mapping per tag identifier...
create unique index idx_nfc_tag_mappings_active_labourlink_uuid
  on nfc_tag_mappings(labourlink_tag_uuid)
  where deactivated_at is null and labourlink_tag_uuid is not null;
create unique index idx_nfc_tag_mappings_active_ridder_id
  on nfc_tag_mappings(ridder_hardware_id)
  where deactivated_at is null and ridder_hardware_id is not null;

-- ...and at most one active mapping per target (bidirectional reassignment
-- confirmation on the app side is only meaningful if the DB actually
-- enforces both directions).
create unique index idx_nfc_tag_mappings_active_row
  on nfc_tag_mappings(greenhouse_row_id)
  where deactivated_at is null and greenhouse_row_id is not null;
create unique index idx_nfc_tag_mappings_active_carrier
  on nfc_tag_mappings(carrier_id)
  where deactivated_at is null and carrier_id is not null;
