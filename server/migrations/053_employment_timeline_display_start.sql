-- Employment Timeline: an Administrator-configurable display cutoff for the
-- "Fit all"/Full timeline graph — see EmploymentTimelineTab.tsx's "Timeline
-- starts" setting. This is a DISPLAY-ONLY preference: it never touches
-- employees.start_date or any employee_employment_periods row, and it never
-- causes an employee's true start date to be hidden or lost — a period that
-- began before this date still renders (clipped at the display boundary
-- with a continuation indicator; see computeBarPosition's clippedStart),
-- and every tooltip/export still shows the real, unmodified start date.
--
-- Additive: one new nullable column on the existing org_settings singleton
-- (049_midnight_rollover.sql) — no data migration, no default value. NULL
-- means "no saved cutoff" — the client falls back to the earliest real
-- start date among currently-included employees, recomputed live (not
-- stored), exactly as it already did before this setting existed.
alter table org_settings
  add column employment_timeline_display_start date;
