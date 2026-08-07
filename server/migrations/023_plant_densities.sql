-- Plant Density: a named group of greenhouse rows, independent of Employee
-- Blocks (022_employee_blocks.sql) — a row may belong to one of each
-- simultaneously, since these are two separate join tables. No numeric
-- density value yet; this is purely the named row-grouping, same shape as
-- employee_blocks/employee_block_rows. Deleting a density only removes its
-- row links (cascade below), never the rows themselves.
create table plant_densities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- greenhouse_row_id is the primary key (not a composite of density_id +
-- greenhouse_row_id) so "each row belongs to at most one density" is
-- enforced by the schema itself — same convention as
-- employee_block_rows.greenhouse_row_id.
create table plant_density_rows (
  density_id uuid not null references plant_densities(id) on delete cascade,
  greenhouse_row_id uuid primary key references greenhouse_rows(id) on delete cascade
);

create index idx_plant_density_rows_density on plant_density_rows (density_id);
