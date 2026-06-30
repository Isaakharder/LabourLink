# Contract Domain

## Overview

A Contract defines the pay and time rules that govern how an employee's
work is measured and compensated. One Contract can be assigned to many
employees. Its rules are versioned through Contract Profiles so that
historical payroll is never retroactively changed when rules are updated.

**Naming note:** The database table is named `contract_templates` (established
in migration 001). The application UI calls these records **Contracts**.
Both names refer to the same entity. New code must use `contract_templates`
as the table name.

---

## Domain Decisions

### Contracts

**1. A Contract has a name, an active/inactive flag, and many employees.**
Contracts are master data. They are configured once and assigned to
employees. Multiple employees may share the same Contract.

**2. Deactivating a Contract prevents new assignments but preserves existing ones.**
Setting `is_active = FALSE` signals that this Contract should no longer be
offered when creating or editing employment records. Employees currently
assigned to it are unaffected. Their historical registrations remain linked
to the same Contract.

**3. Employees are assigned to a Contract through `employment_records`.**
The link is `employment_records.contract_template_id`. The Contract itself
does not hold a list of employees — the relationship is owned by
`employment_records`.

---

### Contract Profiles

**4. Every Contract has one or more Contract Profiles.**
A Profile contains the effective rules for a period of time. A new Contract
begins with exactly one Profile. When rules change, a new Profile is added.

**5. A Profile has a start date. The active Profile is determined by the work date.**
The Profile whose `start_date` is on or before the work date, and whose
`ended_on` is after the work date (or NULL), governs the rules for that day.
If multiple profiles exist for a contract, the one with the latest
`start_date ≤ work_date` is used.

**6. Old profiles are never edited for history-changing changes.**
If a pay rate, overtime threshold, break rule, or any other effective rule
must change, a new Profile is created with the new `start_date`. The old
Profile's columns are left untouched. This preserves the exact rules that
were in force when historical work was performed.

**7. Past registrations must not change when a new Profile is created.**
Payroll calculations always resolve the Profile effective on the work date
at calculation time. Creating a new Profile only affects work performed on
or after its `start_date`.

**8. Minor corrections to the current Profile are permitted before any
registrations are linked to it.**
If a Profile was created today and no registrations have been calculated
against it yet, factual corrections (e.g. a typo in a rate) may be made
directly. Once registrations reference it, changes require a new Profile.
This window is defined by business policy, not enforced by the database.

---

### Profile Sections

A Contract Profile is organised into eight sections. All sections are part
of the same profile record — they do not create separate rows. Tier-based
rules (Breaks, Daily Overtime, Weekly Overtime) are stored in child tables.

**General**
The pay period type and other top-level profile settings.

**Public Holidays**
How work performed on a public holiday is compensated. Includes a pay
multiplier and whether public holiday hours count toward overtime thresholds.

**Work Start Time**
The time at which the work day begins for the purposes of day-boundary
calculation. Critical for shifts that cross midnight — without it, the
system cannot determine which calendar date a registration belongs to.

**Breaks**
Rules that define when breaks are triggered and whether they are paid or
unpaid. Multiple break tiers are supported (e.g. a 30-minute unpaid break
after 6 hours, plus an additional 15-minute paid break after 9 hours).

**Wages**
The base hourly rate. The foundation for all pay calculations.

**Work Hours**
Standard hours per day and per week. Used to determine when the employee
has completed their normal hours and overtime rules should apply.

**Daily Overtime**
Tiered multipliers applied when hours worked in a single day exceed a
threshold. Multiple tiers are supported (e.g. 1.25× after 8h, 1.5× after 10h).

**Weekly Overtime**
Tiered multipliers applied when total hours worked in a week exceed a
threshold. Multiple tiers are supported.

---

## Contract Profile Lifecycle

```
Contract created
  └── Profile 1 created (start_date = contract start)
         └── Rules applied to all registrations from this date forward
  
Rules change
  └── Profile 1 ended_on = new_start_date - 1 day
      Profile 2 created (start_date = new_start_date)
         └── New rules applied from this date forward
             Old registrations still use Profile 1 rules at calculation time
```

---

## Relationship to Other Domains

| Domain | Relationship |
|---|---|
| Employees | Assigned via `employment_records.contract_template_id` |
| Input | Activity registrations carry a work date used to resolve the active Profile |
| Reports | Payroll joins registrations to the Profile effective on each work date |
| Sites | Contracts are not site-scoped; one Contract can span multiple sites |
