-- Tare weight (empty container weight) for carriers used as greenhouse
-- bins — lets weighing math subtract the carrier's own weight from a gross
-- scale reading. Defaults every existing carrier to 0 kg (safe, non-
-- breaking) rather than requiring a backfill script; admins can correct
-- real bins' tare weight afterward via Basic Data > Carriers.
alter table carriers
  add column tare_weight_kg numeric(10, 2) not null default 0
    constraint chk_carriers_tare_weight_non_negative check (tare_weight_kg >= 0);
