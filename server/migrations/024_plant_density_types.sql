-- Splits plant_densities into two independent kinds — Plants and Stems —
-- each with its own per-row count. A greenhouse row may have at most one
-- Plants density AND, separately, at most one Stems density (previously a
-- row could have at most one density total; see 023_plant_densities.sql).
--
-- type is added nullable first, backfilled, then locked down — the
-- migration this repo's README requires when adding a NOT NULL column to
-- a table that might already have rows. Every pre-existing density
-- (before this migration, the feature had no concept of type) becomes
-- 'plants', arbitrarily but harmlessly — there is no way to recover which
-- kind an old row "really" was, and 'plants' is the primary/first-listed
-- kind in the UI. Likewise count_per_row backfills to 1 (the smallest
-- valid positive count) for any pre-existing row, since no real count was
-- ever recorded for it; every density created or edited from here on
-- always supplies a real one via the app's own required-field validation.
alter table plant_densities add column type text;
update plant_densities set type = 'plants' where type is null;
alter table plant_densities alter column type set not null;
alter table plant_densities add constraint chk_plant_densities_type check (type in ('plants', 'stems'));

alter table plant_densities add column count_per_row integer;
update plant_densities set count_per_row = 1 where count_per_row is null;
alter table plant_densities alter column count_per_row set not null;
alter table plant_densities add constraint chk_plant_densities_count_per_row_positive check (count_per_row > 0);

-- (id, type) lets plant_density_rows below reference back to *both* a
-- density's id and its type in one foreign key, so the denormalized
-- density_type on each row link can never drift from the density's own
-- type — enforced by Postgres itself, not just application code.
alter table plant_densities add constraint uq_plant_densities_id_type unique (id, type);

-- density_type is backfilled from the linked density's current type —
-- safe here for the same reason the greenhouse_row_id PK below is safe to
-- replace: 023_plant_densities.sql shipped and was used, if at all, only
-- as the single-type predecessor of this feature, so every existing link
-- (if any) belongs to a density that was just backfilled to 'plants'
-- above.
alter table plant_density_rows add column density_type text;
update plant_density_rows pdr
  set density_type = pd.type
  from plant_densities pd
  where pd.id = pdr.density_id and pdr.density_type is null;
alter table plant_density_rows alter column density_type set not null;

-- Replaces the old "one density per row, period" primary key
-- (greenhouse_row_id alone) with "one density per row *per type*" — a row
-- may now have one plants-type link and one stems-type link
-- simultaneously, but never two of the same type.
alter table plant_density_rows drop constraint plant_density_rows_pkey;
alter table plant_density_rows add constraint plant_density_rows_pkey primary key (greenhouse_row_id, density_type);

-- Ties density_type to the actual type of the density it points at — a
-- link can never claim a type its own density doesn't have.
alter table plant_density_rows
  add constraint fk_plant_density_rows_density_type
  foreign key (density_id, density_type) references plant_densities (id, type);
