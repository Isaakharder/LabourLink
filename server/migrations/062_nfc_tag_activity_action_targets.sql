-- NFC tags can also point at an activity (start/switch to that job) or at a
-- fixed action (start break, end break, end work) — set up from the iPhone
-- app's "Set Up NFC Tag". Additive only: existing row/carrier mappings, their
-- one-active-tag-per-row/carrier unique indexes and the per-tag-ID unique
-- indexes are untouched.
--
-- Unlike rows/carriers, an activity or action may have several active tags
-- (e.g. a Start Break tag at every station), so there is no per-target
-- unique index for them. A tag ID itself still maps to only one thing
-- (idx_nfc_tag_mappings_active_labourlink_uuid / _ridder_id).
--
-- Old Android clients are unaffected: GET /api/mobile/tags/mappings keeps
-- returning only row/carrier mappings unless a client asks for ?include=all.

alter table nfc_tag_mappings
  add column activity_id uuid references activities(id),
  add column action text
    constraint chk_nfc_tag_mappings_action
    check (action in ('start_break', 'end_break', 'end_work'));

alter table nfc_tag_mappings
  drop constraint chk_nfc_tag_mappings_exactly_one_target,
  add constraint chk_nfc_tag_mappings_exactly_one_target
    check (num_nonnulls(greenhouse_row_id, carrier_id, activity_id, action) = 1);

create index idx_nfc_tag_mappings_active_activity
  on nfc_tag_mappings(activity_id)
  where deactivated_at is null and activity_id is not null;
