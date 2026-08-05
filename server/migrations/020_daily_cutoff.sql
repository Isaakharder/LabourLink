-- Marks a time_entries row as closed by the automatic daily-cutoff safety
-- process (see server/src/lib/dailyCutoff.ts) rather than a real employee
-- action or a supervisor correction. Nullable; cleared by the Inputs
-- correction routes when a supervisor later sets a real end time, since at
-- that point the displayed value is a genuine correction, not the cutoff
-- placeholder.
alter table time_entries
  add column auto_closed_at timestamptz;

-- The daily-cutoff process is an automated system action, not something a
-- real employee performed. It still writes to this table (following the
-- existing audit model rather than inventing a parallel one), but with no
-- employee to honestly attribute the change to — relaxed to nullable
-- specifically for that case. Every existing writer in the codebase always
-- supplies a real employee id, so this is a pure widening with no
-- behavior change for any current caller.
alter table time_entry_corrections
  alter column changed_by_employee_id drop not null;
