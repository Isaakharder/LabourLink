-- Employee profile management: add the fields the Employees admin UI needs,
-- constrain the ones with a fixed set of supported values, and relax
-- settings_pin_hash so an employee can be created here without inventing a
-- PIN — desktop login stays exclusively a create-admin/future-admin-action
-- concern, this form never touches it.

alter table employees
  add column employee_number text,
  add column nationality text,
  add column preferred_language text,
  add column notes text,
  add column profile_photo_path text;

-- Nullable at the DB level (existing rows have none, and historical data
-- should never be invented to satisfy a NOT NULL) — required going forward
-- is enforced by the API for new/edited records instead.
alter table employees
  add constraint chk_employees_nationality
    check (nationality is null or nationality in ('Canadian', 'Mexican'));

alter table employees
  add constraint chk_employees_preferred_language
    check (preferred_language is null or preferred_language in ('English', 'Spanish'));

-- gender already existed as free-form text with no constraint; tighten it to
-- the suggested set now that the UI exposes a fixed choice for it. Safe
-- against current data (only ever NULL so far).
alter table employees
  add constraint chk_employees_gender
    check (gender is null or gender in ('Male', 'Female', 'Prefer not to say'));

-- Unique when supplied — Postgres unique constraints already permit multiple
-- NULLs, so this doesn't block employees left without a number.
alter table employees
  add constraint employees_employee_number_key unique (employee_number);

alter table employees
  alter column settings_pin_hash drop not null;
