-- Add independent anchor-side inset for greenhouse row batch placement.
-- Existing batches default to 0 so previously-saved row geometry remains unchanged.
alter table greenhouse_row_batches
  add column anchor_offset_ft numeric not null default 0;

alter table greenhouse_row_batches
  add constraint chk_greenhouse_row_batches_anchor_offset_nonnegative
  check (anchor_offset_ft >= 0);
