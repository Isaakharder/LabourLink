-- Audit trail for every change to a bin's RFID tag or tare weight, whoever
-- makes it: a registration at the weighing station (Register Bins,
-- server/src/routes/scale.ts) or an edit on Basic Data > Carriers
-- (server/src/routes/carriers.ts). Append-only: rows are never updated or
-- deleted, and each change writes its row in the same transaction as the
-- carrier update itself.
--
-- Additive only: one new table. No existing carrier, weighing or other row
-- is touched.
--
-- action:
--   register     the station measured an empty bin and set its tag and tare
--   move_tag     the tag was taken off this bin because it was registered to
--                another bin (a correction); see moved_to_carrier_id
--   remove_tag   the tag was removed at the station (a correction)
--   page_create  a carrier was created on the Carriers page with a tag or tare
--   page_edit    the tag or tare was changed on the Carriers page
create table carrier_registration_audit (
  id uuid primary key default gen_random_uuid(),
  -- The station's own id for one registration request, so a retried
  -- request is never applied twice. One request can write two rows (the
  -- bin registered, and the bin a moved tag came from), hence unique per
  -- carrier rather than alone. Null for Carriers page edits.
  registration_id uuid,
  carrier_id uuid not null references carriers(id),
  station_id uuid references scale_stations(id),
  source text not null check (source in ('scale_station', 'carriers_page')),
  action text not null check (action in ('register', 'move_tag', 'remove_tag', 'page_create', 'page_edit')),
  old_rfid_tag text,
  new_rfid_tag text,
  old_tare_weight_kg numeric(10, 2),
  new_tare_weight_kg numeric(10, 2),
  -- What the station measured (registrations only).
  measured_gross_kg numeric(10, 2),
  measured_samples_kg jsonb,
  indicator_status text,
  stable_ms integer,
  empty_confirmed boolean,
  overwrite_confirmed boolean,
  moved_to_carrier_id uuid references carriers(id),
  moved_from_carrier_id uuid references carriers(id),
  performed_by_employee_id uuid not null references employees(id),
  performed_at timestamptz not null default now(),
  reason text,
  constraint carrier_registration_audit_once unique (registration_id, carrier_id)
);
create index idx_carrier_registration_audit_carrier on carrier_registration_audit (carrier_id, performed_at desc);
