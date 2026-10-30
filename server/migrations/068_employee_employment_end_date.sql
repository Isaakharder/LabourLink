-- Employment Timeline simplification: one source of truth for an
-- employee's employment dates, on the employee record itself.
--
-- The timeline's blue bar is now drawn only from three employees columns,
-- the same ones the Employees Directory shows and edits:
--   Employment Start Date   = employees.start_date              (existing)
--   Work Permit Expiry Date = employees.work_permit_expiry_date (existing, 047)
--   End Different Date      = employees.employment_end_date     (NEW, below)
-- The bar ends on End Different Date when set, otherwise on the permit
-- expiry, otherwise it is ongoing. End Different Date records that the
-- employee actually stopped working on a date different from the permit
-- expiry; it never changes the permit expiry, never deactivates anyone and
-- never touches time entries or payroll.
--
-- employee_employment_periods (050) is no longer read for dates or written
-- by the application. It is kept unchanged — rows, history and constraints —
-- as the record of what the timeline showed before this change and for
-- rollback. Its employment_type/work_group values are still shown and
-- filterable on the timeline, read-only.
--
-- Additive and safe to apply while the previous application version is
-- running: one nullable column, no constraint the old code could trip over
-- (the "not before the start date" rule is enforced by the API on every
-- save path), and the old code never reads or writes it.

alter table employees
  add column employment_end_date date;

comment on column employees.employment_end_date is
  'End Different Date: the day the employee actually stopped working, when different from work_permit_expiry_date. Display/record only — never deactivates.';

-- Backfill from the timeline's old "actual finish date": for each employee,
-- the actual_finish_date of their LATEST employment period (by start date),
-- so a later open period (re-employed) correctly leaves no end date. Only
-- when it isn't earlier than the employee's start date (none are in
-- production as of 2026-10-30). Start dates are deliberately NOT copied:
-- the Directory's employees.start_date is the source of truth.
update employees e
set employment_end_date = latest.actual_finish_date
from (
  select distinct on (employee_id) employee_id, actual_finish_date
  from employee_employment_periods
  order by employee_id, start_date desc, created_at desc
) latest
where latest.employee_id = e.id
  and latest.actual_finish_date is not null
  and (e.start_date is null or latest.actual_finish_date >= e.start_date);
