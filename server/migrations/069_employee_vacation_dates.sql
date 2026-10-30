-- Employment Timeline: one planned vacation per employee, on the employee
-- record (one source of truth with the Employees Directory form, like the
-- employment dates in 068). Planning information only: nothing here
-- deactivates anyone, creates breaks, or touches time entries, payroll or
-- phone syncing.
--
-- Both dates are set together or both left empty, and End Vacation can't be
-- before Start Vacation — enforced here because nothing but the new
-- application ever writes these columns. The rules that depend on other
-- dates (not before the Employment Start Date, not past End Different
-- Date / Work Permit Expiry Date) are enforced by the API on every save
-- path, so an older application changing those dates can never trip a
-- database error.
--
-- Additive and safe to apply while the previous application version is
-- running: two nullable columns it never reads or writes.

alter table employees
  add column vacation_start_date date,
  add column vacation_end_date date,
  add constraint chk_employees_vacation_dates
    check (
      (vacation_start_date is null and vacation_end_date is null)
      or (vacation_start_date is not null and vacation_end_date is not null and vacation_end_date >= vacation_start_date)
    );

comment on column employees.vacation_start_date is 'Start Vacation (inclusive): planning information shown on the Employment Timeline only.';
comment on column employees.vacation_end_date is 'End Vacation (inclusive): planning information shown on the Employment Timeline only.';
