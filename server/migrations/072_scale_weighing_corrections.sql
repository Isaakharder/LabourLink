-- Administrator corrections of scale weighing credits (Scale Weighings page,
-- server/src/routes/scaleWeighings.ts), and the one shared definition of
-- which weighings count.
--
-- Additive only: one new table and two views. No existing row changes.
--
-- A correction never deletes or rewrites a weighing. Voiding a credit sets
-- scale_weighings.status = 'voided' and keeps the original employee_id,
-- weights and claims; this table records who voided it, when, why, and what
-- it was before. Append-only.
create table scale_weighing_corrections (
  id uuid primary key default gen_random_uuid(),
  -- The client's own id for one correction request, so a repeated request
  -- (double click, retry after a lost response) is applied exactly once.
  correction_id uuid not null,
  weighing_id uuid not null references scale_weighings(id),
  action text not null check (action in ('void')),
  reason text not null check (length(trim(reason)) >= 3),
  previous_status text not null,
  previous_employee_id uuid references employees(id),
  performed_by_employee_id uuid not null references employees(id),
  performed_at timestamptz not null default now(),
  constraint scale_weighing_corrections_request_key unique (correction_id)
);
-- A credit can be voided once.
create unique index scale_weighing_corrections_one_void on scale_weighing_corrections (weighing_id) where action = 'void';

-- What counts toward production totals (kilograms harvested, bins
-- weighed): every weighing except voided ones and duplicates (the same bin
-- weighed again within five minutes). Trial weighings are real bins and
-- count here.
create view scale_production_weighings as
  select * from scale_weighings where status <> 'voided' and not is_duplicate;

-- What counts as an employee's credit: credited, from a station whose
-- credits were live at the time. Voided, trial, pending, needs-review and
-- expired weighings never count. Any report or payroll calculation that
-- uses scale weighings must read these two views, never the table, so a
-- correction is applied the same way everywhere.
create view scale_employee_credits as
  select * from scale_weighings where status = 'credited' and credits_live;
