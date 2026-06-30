# Chapter 3 — Employee Schema Design

**Status:** Design — not yet implemented
**Precedes:** Migration 002 (sites), 003 (employees + employment)

---

## Table List

Tables are listed in dependency order (each table may only reference tables above it).

| # | Table | Category | Description |
|---|---|---|---|
| 1 | `sites` | Master | Greenhouse sites under the company |
| 2 | `teams` | Master | Named groups of employees, scoped to a site |
| 3 | `contract_templates` | Master | Pay and hour definitions; full design in Chapter 4 |
| 4 | `employees` | Master | Person identity; never deleted |
| 5 | `employment_records` | Versioned master | Effective employment: site, role, team, contract, supervisor |
| 6 | `devices` | Master | Registered Android phones |
| 7 | `device_assignments` | History | Which employee holds a device; append-only |
| 8 | `device_login_history` | Event | Every login event on any device; append-only |

> `contract_templates` already exists as a placeholder from migration 001.
> `employees` and `employment_history` (placeholder) exist from migration 001.
> All three will be replaced or altered in the Chapter 3 migration.

---

## Table Definitions

---

### `sites`

Physical greenhouse sites operated by the company.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `name` | TEXT | NO | — | Full site name |
| `code` | TEXT | NO | — | Short uppercase identifier, e.g. `GH-A` |
| `address` | TEXT | YES | — | Street address |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (code)`

---

### `teams`

Named groups of employees belonging to a single site.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `site_id` | INTEGER | NO | — | FK → `sites.id` |
| `name` | TEXT | NO | — | Team name |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (site_id, name)` — team names are unique within a site

---

### `contract_templates`

Stub table; full column design is in Chapter 4.
Present here because `employment_records` references it.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `name` | TEXT | NO | — | Display name |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

---

### `employees`

Core identity record for a person. Never hard-deleted.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_number` | TEXT | NO | — | Company-assigned identifier; see open question #1 |
| `first_name` | TEXT | NO | — | |
| `last_name` | TEXT | NO | — | |
| `date_of_birth` | DATE | YES | — | |
| `phone` | TEXT | YES | — | Contact number |
| `email` | TEXT | YES | — | Contact email |
| `notes` | TEXT | YES | — | Internal notes |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete; set when employee leaves |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (employee_number)`

> National ID (BSN) is not included here. See open question #7.

---

### `employment_records`

Effective employment record linking an employee to a site, role, team,
contract, and supervisor for a defined date range.

Replaces the placeholder `employment_history` table from migration 001.

One record per employee may have `ended_on IS NULL` at any time —
this is the current (active) employment record.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_id` | INTEGER | NO | — | FK → `employees.id` |
| `site_id` | INTEGER | NO | — | FK → `sites.id`; primary site for this employment |
| `contract_template_id` | INTEGER | YES | — | FK → `contract_templates.id` |
| `team_id` | INTEGER | YES | — | FK → `teams.id` |
| `supervisor_id` | INTEGER | YES | — | FK → `employees.id`; self-referential |
| `role` | TEXT | YES | — | Job role or title |
| `started_on` | DATE | NO | — | First effective date of this employment record |
| `ended_on` | DATE | YES | NULL | NULL = currently active; set when superseded |
| `notes` | TEXT | YES | — | Reason for change or other context |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `created_by` | INTEGER | YES | — | FK → `employees.id`; who created the record |

**Constraints:**
- `CHECK (ended_on IS NULL OR ended_on > started_on)` — valid date range
- `CHECK (supervisor_id IS NULL OR supervisor_id != employee_id)` — no self-supervision

> No `updated_at` — this table is append-only. Records are ended (by setting `ended_on`)
> and replaced by a new record. The old record is never modified after creation.

---

### `devices`

Android phones registered to the LabourLink system.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `site_id` | INTEGER | NO | — | FK → `sites.id`; home site of the device |
| `name` | TEXT | NO | — | Human-readable label, e.g. `Phone 3 - GH-A` |
| `identifier` | TEXT | NO | — | Unique device token generated on first registration; see open question #5 |
| `is_shared` | BOOLEAN | NO | FALSE | `TRUE` = shared pool; `FALSE` = assigned to one employee |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete; set when device is decommissioned |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (identifier)`

---

### `device_assignments`

Records which employee an assigned (`is_shared = FALSE`) device is linked to.
Append-only. The active assignment is the row with `ended_at IS NULL`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `device_id` | INTEGER | NO | — | FK → `devices.id` |
| `employee_id` | INTEGER | NO | — | FK → `employees.id` |
| `started_at` | TIMESTAMPTZ | NO | NOW() | When this assignment began |
| `ended_at` | TIMESTAMPTZ | YES | NULL | NULL = currently active assignment |
| `changed_by` | INTEGER | NO | — | FK → `employees.id`; manager/admin who authorised |
| `change_reason` | TEXT | YES | — | Optional reason for the change |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |

> No `updated_at` or `archived_at` — rows are never modified.
> Ending an assignment sets `ended_at` on the old row and inserts a new row.

---

### `device_login_history`

Records every login event on any device — both shared (employee selection)
and assigned (implicit login when the device is unlocked / app is opened).
Append-only. Used for audit and for linking registrations to a specific
login session.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `device_id` | INTEGER | NO | — | FK → `devices.id` |
| `employee_id` | INTEGER | NO | — | FK → `employees.id`; who was logged in |
| `logged_in_at` | TIMESTAMPTZ | NO | NOW() | |
| `logged_out_at` | TIMESTAMPTZ | YES | NULL | NULL = session still open |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |

> On shared devices, `employee_id` is set by the employee's manual selection.
> On assigned devices, `employee_id` is set from the active `device_assignment`.

---

## Relationships

```
sites
 ├──< teams            (teams.site_id)
 ├──< employment_records (employment_records.site_id)
 └──< devices          (devices.site_id)

employees
 ├──< employment_records.employee_id
 ├──< employment_records.supervisor_id   [self-ref]
 ├──< employment_records.created_by      [audit ref]
 ├──< device_assignments.employee_id
 ├──< device_assignments.changed_by      [audit ref]
 └──< device_login_history.employee_id

teams
 └──< employment_records.team_id

contract_templates
 └──< employment_records.contract_template_id

devices
 ├──< device_assignments.device_id
 └──< device_login_history.device_id
```

---

## Indexes

### `sites`
```sql
-- No additional indexes beyond PK and UNIQUE (code)
```

### `teams`
```sql
INDEX (site_id)
UNIQUE (site_id, name)
```

### `employees`
```sql
UNIQUE (employee_number)
INDEX (archived_at)        -- filter active employees efficiently
INDEX (last_name)          -- name search
```

### `employment_records`
```sql
-- Current record per employee (the most frequent query)
UNIQUE (employee_id) WHERE (ended_on IS NULL)

-- Chronological lookup for one employee
INDEX (employee_id, started_on)

-- All employees at a site
INDEX (site_id)

-- All employees in a team
INDEX (team_id)
```

### `devices`
```sql
UNIQUE (identifier)
INDEX (site_id)
INDEX (archived_at)
```

### `device_assignments`
```sql
-- Current assignment per device
UNIQUE (device_id) WHERE (ended_at IS NULL)

-- Chronological assignment history per device
INDEX (device_id, started_at)

-- All devices ever assigned to an employee
INDEX (employee_id)
```

### `device_login_history`
```sql
INDEX (device_id, logged_in_at)
INDEX (employee_id, logged_in_at)

-- Open sessions (NULL logged_out_at) — for detecting stale sessions
INDEX (device_id) WHERE (logged_out_at IS NULL)
```

---

## Constraints

| Table | Constraint | Type | Rule |
|---|---|---|---|
| `sites` | `sites_code_key` | UNIQUE | `code` is unique across all sites |
| `teams` | `teams_site_name_key` | UNIQUE | `(site_id, name)` — team names unique per site |
| `employees` | `employees_number_key` | UNIQUE | `employee_number` is unique |
| `employment_records` | `er_current_unique` | PARTIAL UNIQUE | `(employee_id) WHERE ended_on IS NULL` |
| `employment_records` | `er_date_range_check` | CHECK | `ended_on IS NULL OR ended_on > started_on` |
| `employment_records` | `er_no_self_supervise` | CHECK | `supervisor_id IS NULL OR supervisor_id != employee_id` |
| `devices` | `devices_identifier_key` | UNIQUE | `identifier` is unique |
| `device_assignments` | `da_current_unique` | PARTIAL UNIQUE | `(device_id) WHERE ended_at IS NULL` |

---

## Soft Delete / Archive Approach

### Master data (`sites`, `teams`, `employees`, `devices`, `contract_templates`)

Soft-deleted using an `archived_at TIMESTAMPTZ` column.

```
Active record:   archived_at IS NULL
Archived record: archived_at IS NOT NULL  (timestamp = when it was archived)
```

Standard active-record filter for all queries: `WHERE archived_at IS NULL`

Archiving never cascades. An archived employee's `employment_records` and
`device_assignments` remain intact and visible in history.
An archived `team` is preserved on the `employment_records` that referenced it.

### Versioned master data (`employment_records`)

This table does not use `archived_at`. Records have a natural lifecycle
defined by `(started_on, ended_on)`.

```
Current record:    ended_on IS NULL
Historical record: ended_on IS NOT NULL
```

When an employment record changes:
1. Set `ended_on = new_record.started_on` on the current record
2. Insert the new record with `ended_on = NULL`

Both operations happen in a single transaction.
The old record is never modified in any other way.

### Append-only tables (`device_assignments`, `device_login_history`)

No soft delete. These are event/history tables and are never removed.
`ended_at` / `logged_out_at` mark the end of a period; NULL means still open.

---

## Current-Record Rules

These are the canonical queries for "what is active right now."

| What | Query condition |
|---|---|
| Active employees | `employees WHERE archived_at IS NULL` |
| Active sites | `sites WHERE archived_at IS NULL` |
| Active teams | `teams WHERE archived_at IS NULL` |
| Active devices | `devices WHERE archived_at IS NULL` |
| Current employment record for employee X | `employment_records WHERE employee_id = X AND ended_on IS NULL` |
| Current device assignment for device D | `device_assignments WHERE device_id = D AND ended_at IS NULL` |
| Open login session for device D | `device_login_history WHERE device_id = D AND logged_out_at IS NULL` |

The partial unique indexes on `employment_records` and `device_assignments`
guarantee that these queries return at most one row per employee/device.

---

## Open Questions

These must be answered before the migration is written.

**Q1 — Employee number format**
Is `employee_number` auto-generated (e.g. `EMP-0001`) or manually assigned
by the manager? Is it scoped per company or per site? Can it be changed
after creation?

**Q2 — Multi-site employment model**
Decision 13 says an employee may work at multiple sites. The current design
gives each employee one active `employment_record` with one `site_id`
(primary site). Cross-site work is recorded at registration time by tagging
the registration with the actual site.

Is this correct, or should an employee be able to have *two simultaneous*
active employment records — one per site? The latter would require relaxing
the partial unique constraint `(employee_id) WHERE ended_on IS NULL`.

**Q3 — Supervisor scope**
Can a `supervisor_id` reference an employee at a different site, or must the
supervisor belong to the same site as the employment record?
Should this be enforced at the DB level or only at the app level?

**Q4 — Team scope**
The current design makes teams site-specific (`teams.site_id`).
Can a team ever span multiple sites, or is site-scoped always correct?

**Q5 — Device identifier**
Android device IDs can change after a factory reset. The current design
uses a `devices.identifier` column seeded by the app on first launch
(a LabourLink-generated UUID stored in secure local storage).
Confirm this approach, or identify an alternative hardware identifier.

**Q6 — Login history scope**
Should `device_login_history` record every app open on an assigned device,
or only explicit employee selections on shared devices?
Full recording is safer for audit but generates significantly more rows
in high-usage environments.

**Q7 — Sensitive personal data (BSN / National ID)**
Should national ID / social security numbers be stored in the `employees`
table alongside name and DOB, or in a separate `employee_sensitive_data`
table restricted by a different API permission level?

**Q8 — Role as text vs lookup table**
`employment_records.role` is TEXT in this design. Should it reference a
`roles` lookup table to enable role-based reporting and filtering?
A lookup table is easy to add in Chapter 3; retrofitting it later breaks
existing text values.

**Q9 — PIN / credential storage**
Manager and admin PINs are required to reassign devices (Decision 11).
Where are these stored? Options:
- `employees.pin_hash` — simple, but mixes identity with credential
- Separate `employee_credentials` table — cleaner separation
- App-level only, verified on the mobile device without hitting the API

**Q10 — Company anchor table**
In v1, there is one company. Should a `companies` table exist as the
root of the data model (sites belong to a company), or is it premature
for a single-tenant local-first system? Adding it later requires a
migration touching every site-scoped table.
