# Chapter 3 — Employee Schema Design

**Status:** Design — not yet implemented
**Precedes:** Migrations 002–007

---

## Table List

Tables are listed in dependency order (each table may only reference tables above it).

| # | Table | Category | Description |
|---|---|---|---|
| 1 | `companies` | Master | Root anchor; one company per installation |
| 2 | `sites` | Master | Greenhouse sites belonging to the company |
| 3 | `security_roles` | Master (seeded) | System access roles; seeded on first migration |
| 4 | `teams` | Master | Named groups of employees, scoped to a site |
| 5 | `contract_templates` | Master | Pay and hour definitions; full design in Chapter 4 |
| 6 | `employees` | Master | Person identity; never deleted |
| 7 | `employee_credentials` | Master (restricted) | Hashed PINs; access-controlled separately from identity |
| 8 | `employee_security_role_assignments` | History | Active and historical role assignments per employee |
| 9 | `employment_records` | Versioned master | Effective employment: site, role, team, contract, supervisor |
| 10 | `devices` | Master | Registered Android phones |
| 11 | `device_assignments` | History | Which employee holds a device; append-only |
| 12 | `device_login_history` | Event | Every login event on any device; append-only |

> `contract_templates`, `employees`, and `employment_history` (placeholder) exist from
> migration 001 as stubs. All three will be dropped and recreated in the Chapter 3 migrations.

---

## Table Definitions

---

### `companies`

Root anchor for the entire installation. In v1 exactly one row exists.
Present now so that `sites` has a proper foreign key from the start.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `name` | TEXT | NO | — | Company legal name |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

---

### `sites`

Physical greenhouse sites operated by the company.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `company_id` | INTEGER | NO | — | FK → `companies.id` |
| `name` | TEXT | NO | — | Full site name |
| `code` | TEXT | NO | — | Short uppercase identifier, e.g. `GH-A` |
| `address` | TEXT | YES | — | Street address |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (company_id, code)` — site codes are unique within a company

---

### `security_roles`

System access roles. Seeded by migration; not created by users at runtime.
Controls what screens and actions an employee may access in both the web
and mobile apps.

Security role is separate from job role/title. An employee's job title
(e.g. "Packer", "Harvester") lives on `employment_records.role`. The
security role determines system permissions only.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `name` | TEXT | NO | — | Display name |
| `description` | TEXT | YES | — | What access this role grants |
| `is_default` | BOOLEAN | NO | FALSE | Role assigned when none is specified; exactly one must be TRUE |
| `sort_order` | INTEGER | NO | 0 | Controls dropdown display order |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete; prevents new assignments but preserves history |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:**
- `UNIQUE (name)`
- `UNIQUE (is_default) WHERE (is_default = TRUE)` — partial unique; enforces exactly one default

**Seed data (applied by migration):**

| sort_order | name | description | is_default |
|---|---|---|---|
| 1 | General | Regular employee — mobile clock-in/clock-out only | TRUE |
| 2 | Crew Leader | Can view team registrations and close shifts for others | FALSE |
| 3 | Supervisor | Can manage employees and registrations within their site | FALSE |
| 4 | Manager | Can manage all data including contracts and locations | FALSE |
| 5 | Admin | Full system access including configuration and user management | FALSE |

> Permission boundaries per role are enforced at the API level, not in the database.
> The database records the assignment; the API decides what each role may do.

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

Security role is **not** stored here. It is assigned separately via
`employee_security_role_assignments` so that role history is preserved.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_number` | TEXT | NO | — | Unique identifier; see open question Q1 |
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

> National ID (BSN) is not included here. See open question Q7.

---

### `employee_credentials`

Stores hashed PINs for employees who require device-level authentication
(Crew Leader and above). Kept separate from `employees` to allow tighter
API-level access control on credential data.

PINs are **never** stored in plaintext. Only a bcrypt or Argon2id hash is
stored. The plaintext PIN is discarded immediately after hashing at the API.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_id` | INTEGER | NO | — | FK → `employees.id` |
| `pin_hash` | TEXT | YES | NULL | Hashed PIN; NULL if no PIN has been set |
| `pin_set_at` | TIMESTAMPTZ | YES | NULL | Timestamp of last PIN change |
| `pin_set_by` | INTEGER | YES | — | FK → `employees.id`; admin who set the PIN |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (employee_id)` — one credentials row per employee

> A row in this table is created for every employee at creation time (with
> `pin_hash = NULL`). This avoids the need for nullable LEFT JOINs when
> checking credential status.

---

### `employee_security_role_assignments`

Tracks which security role an employee holds. Follows the same append-only
history pattern as `device_assignments` and `employment_records`.

The active assignment is the row with `ended_at IS NULL`.
Changing a role ends the current assignment and inserts a new one in the
same transaction.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_id` | INTEGER | NO | — | FK → `employees.id` |
| `security_role_id` | INTEGER | NO | — | FK → `security_roles.id` |
| `started_at` | TIMESTAMPTZ | NO | NOW() | When this role assignment began |
| `ended_at` | TIMESTAMPTZ | YES | NULL | NULL = currently active |
| `changed_by` | INTEGER | YES | — | FK → `employees.id`; admin who made the change |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:**
- `UNIQUE (employee_id) WHERE (ended_at IS NULL)` — only one active role per employee

> No `updated_at` — rows are never modified after creation.
> When an employee is created, a role assignment is immediately inserted
> using either the selected role or the `is_default = TRUE` role (General).

---

### `employment_records`

Effective employment record linking an employee to a site, job role, team,
contract, and supervisor for a defined date range.

Replaces the placeholder `employment_history` table from migration 001.

One record per employee may have `ended_on IS NULL` at a time — this is
the current (active) employment record. (Q2: **confirmed** — one active
record per employee.)

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_id` | INTEGER | NO | — | FK → `employees.id` |
| `site_id` | INTEGER | NO | — | FK → `sites.id`; primary site for this employment |
| `contract_template_id` | INTEGER | YES | — | FK → `contract_templates.id` |
| `team_id` | INTEGER | YES | — | FK → `teams.id` |
| `supervisor_id` | INTEGER | YES | — | FK → `employees.id`; self-referential |
| `role` | TEXT | YES | — | Job role or title (e.g. "Harvester"); see open question Q8 |
| `started_on` | DATE | NO | — | First effective date of this record |
| `ended_on` | DATE | YES | NULL | NULL = currently active; set when superseded |
| `notes` | TEXT | YES | — | Reason for change or other context |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `created_by` | INTEGER | YES | — | FK → `employees.id`; who created the record |

**Constraints:**
- `UNIQUE (employee_id) WHERE (ended_on IS NULL)` — one active employment record per employee
- `CHECK (ended_on IS NULL OR ended_on > started_on)` — valid date range
- `CHECK (supervisor_id IS NULL OR supervisor_id != employee_id)` — no self-supervision

> No `updated_at` — this table is append-only. To change an employment record:
> set `ended_on` on the current row, then insert a new row. Both in one transaction.

---

### `devices`

Android phones registered to the LabourLink system.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `site_id` | INTEGER | NO | — | FK → `sites.id`; home site of the device |
| `name` | TEXT | NO | — | Human-readable label, e.g. `Phone 3 — GH-A` |
| `identifier` | TEXT | NO | — | LabourLink-generated UUID; stored in app's secure storage |
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
| `ended_at` | TIMESTAMPTZ | YES | NULL | NULL = currently active |
| `changed_by` | INTEGER | NO | — | FK → `employees.id`; manager/admin who authorised |
| `change_reason` | TEXT | YES | — | Optional reason for the change |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |

> No `updated_at` or `archived_at` — rows are never modified.
> Ending an assignment sets `ended_at` on the old row and inserts a new row.

---

### `device_login_history`

Records every login event on any device — both shared (employee selection)
and assigned (implicit login when the device is unlocked/app opened).
Append-only. Used for audit and for linking registrations to a login session.

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
companies
 └──< sites                              (sites.company_id)

sites
 ├──< teams                              (teams.site_id)
 ├──< employment_records                 (employment_records.site_id)
 └──< devices                            (devices.site_id)

security_roles
 └──< employee_security_role_assignments (esra.security_role_id)

teams
 └──< employment_records                 (employment_records.team_id)

contract_templates
 └──< employment_records                 (employment_records.contract_template_id)

employees
 ├──< employee_credentials               (employee_credentials.employee_id)       [1:1]
 ├──< employee_credentials.pin_set_by    [audit ref]
 ├──< employee_security_role_assignments (esra.employee_id)
 ├──< employee_security_role_assignments.changed_by  [audit ref]
 ├──< employment_records.employee_id
 ├──< employment_records.supervisor_id   [self-ref]
 ├──< employment_records.created_by      [audit ref]
 ├──< device_assignments.employee_id
 ├──< device_assignments.changed_by      [audit ref]
 └──< device_login_history.employee_id

devices
 ├──< device_assignments.device_id
 └──< device_login_history.device_id
```

---

## Indexes

### `companies`
```sql
-- No additional indexes beyond PK
```

### `sites`
```sql
INDEX (company_id)
UNIQUE (company_id, code)
```

### `security_roles`
```sql
UNIQUE (name)
UNIQUE (is_default) WHERE (is_default = TRUE)
```

### `teams`
```sql
INDEX (site_id)
UNIQUE (site_id, name)
```

### `employees`
```sql
UNIQUE (employee_number)
INDEX (archived_at)           -- filter active employees
INDEX (last_name)             -- name search
```

### `employee_credentials`
```sql
UNIQUE (employee_id)
```

### `employee_security_role_assignments`
```sql
-- Current role per employee
UNIQUE (employee_id) WHERE (ended_at IS NULL)

-- Role history per employee
INDEX (employee_id, started_at)

-- All employees currently holding a given role
INDEX (security_role_id) WHERE (ended_at IS NULL)
```

### `employment_records`
```sql
-- Current record per employee
UNIQUE (employee_id) WHERE (ended_on IS NULL)

-- Chronological history per employee
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

-- Chronological history per device
INDEX (device_id, started_at)

-- All devices ever assigned to an employee
INDEX (employee_id)
```

### `device_login_history`
```sql
INDEX (device_id, logged_in_at)
INDEX (employee_id, logged_in_at)

-- Open sessions
INDEX (device_id) WHERE (logged_out_at IS NULL)
```

---

## Constraints

| Table | Constraint | Type | Rule |
|---|---|---|---|
| `sites` | `sites_company_code_key` | UNIQUE | `(company_id, code)` — codes unique per company |
| `security_roles` | `security_roles_name_key` | UNIQUE | `name` is unique |
| `security_roles` | `security_roles_one_default` | PARTIAL UNIQUE | `(is_default) WHERE is_default = TRUE` |
| `teams` | `teams_site_name_key` | UNIQUE | `(site_id, name)` — team names unique per site |
| `employees` | `employees_number_key` | UNIQUE | `employee_number` is unique |
| `employee_credentials` | `ec_employee_key` | UNIQUE | One credentials row per employee |
| `esra` | `esra_current_unique` | PARTIAL UNIQUE | `(employee_id) WHERE ended_at IS NULL` |
| `employment_records` | `er_current_unique` | PARTIAL UNIQUE | `(employee_id) WHERE ended_on IS NULL` |
| `employment_records` | `er_date_range_check` | CHECK | `ended_on IS NULL OR ended_on > started_on` |
| `employment_records` | `er_no_self_supervise` | CHECK | `supervisor_id IS NULL OR supervisor_id != employee_id` |
| `devices` | `devices_identifier_key` | UNIQUE | `identifier` is unique |
| `device_assignments` | `da_current_unique` | PARTIAL UNIQUE | `(device_id) WHERE ended_at IS NULL` |

---

## Soft Delete / Archive Approach

### Master data

Tables: `companies`, `sites`, `security_roles`, `teams`, `employees`,
`employee_credentials`, `contract_templates`, `devices`

Soft-deleted using `archived_at TIMESTAMPTZ`.

```
Active record:   archived_at IS NULL
Archived record: archived_at IS NOT NULL
```

Archiving never cascades. All foreign key references to archived records
remain intact. Historical data is never touched.

Archiving a `security_role` prevents new assignments to it but does not
affect existing active assignments. The role name is preserved on all
historical `employee_security_role_assignments` rows.

### Versioned master data

Tables: `employment_records`, `employee_security_role_assignments`

No `archived_at`. Lifecycle is managed through `(started_on/at, ended_on/at)`.

```
Current record:    ended_on IS NULL  /  ended_at IS NULL
Historical record: ended_on IS NOT NULL  /  ended_at IS NOT NULL
```

**To change a versioned record:**
1. Set `ended_on` / `ended_at` on the current row
2. Insert the new row with `ended_on` / `ended_at` = NULL

Both steps in a single transaction. The old row is never modified
in any other way after creation.

### Append-only tables

Tables: `device_assignments`, `device_login_history`

No delete mechanism of any kind. Rows accumulate indefinitely.
`ended_at` / `logged_out_at` mark the end of a period; NULL = still open.

---

## Current-Record Rules

| What | Condition |
|---|---|
| Active companies | `archived_at IS NULL` |
| Active sites | `archived_at IS NULL` |
| Active security roles | `archived_at IS NULL` |
| Active employees | `archived_at IS NULL` |
| Current security role for employee X | `employee_id = X AND ended_at IS NULL` |
| Current employment record for employee X | `employee_id = X AND ended_on IS NULL` |
| Current device assignment for device D | `device_id = D AND ended_at IS NULL` |
| Open login session for device D | `device_id = D AND logged_out_at IS NULL` |

The partial unique indexes on `employee_security_role_assignments`,
`employment_records`, and `device_assignments` guarantee that these
queries return at most one row per employee/device.

---

## Employee Creation Flow

When creating a new employee, the following rows are inserted in one transaction:

1. **`employees`** — identity record
2. **`employee_credentials`** — one row with `pin_hash = NULL`
3. **`employee_security_role_assignments`** — one row using the selected role,
   or the `is_default = TRUE` role (General) if none was selected

The Security Role dropdown in the employee form must be populated from
`security_roles WHERE archived_at IS NULL ORDER BY sort_order`.

---

## Resolved Questions

**Q2 — Multi-site employment model: RESOLVED**
One active `employment_record` per employee at a time, enforced by the partial
unique constraint. An employee's *primary* site is their employment record's
`site_id`. Cross-site activity registrations are tagged with the actual site
at registration time; no separate employment record is needed for secondary sites.

**Q9 — PIN / credential storage: RESOLVED**
PINs are stored as hashes only (bcrypt or Argon2id) in the separate
`employee_credentials` table. Plaintext PINs are never persisted. The
credentials table is access-controlled independently from `employees`.

**Q10 — Company anchor table: RESOLVED**
`companies` table is added now as the root of the data model.
`sites.company_id` carries the FK. No other tables reference `companies`
directly; the company is reached through the site chain.

---

## Open Questions

**Q1 — Employee number format**
Is `employee_number` auto-generated (e.g. `EMP-0001`) or manually assigned
by the manager? Is it scoped per company or per site? Can it be changed
after creation?

**Q3 — Supervisor scope**
Can a `supervisor_id` reference an employee at a different site, or must
the supervisor belong to the same site as the employment record?
Enforced at DB level or app level only?

**Q4 — Team scope**
Teams are currently site-specific (`teams.site_id`). Can a team ever span
multiple sites, or is site-scoped always correct?

**Q5 — Device identifier**
Confirmed approach: LabourLink generates a UUID on first app launch and
stores it in Android secure storage. This survives app updates but not
factory resets. Is this acceptable, or is an alternative needed?

**Q6 — Login history scope**
Should `device_login_history` record every app open on an assigned device,
or only explicit employee selections on shared devices?

**Q7 — Sensitive personal data (BSN / National ID)**
Should national ID numbers be stored in `employees` or in a separate
`employee_sensitive_data` table with restricted API access?

**Q8 — Job role as text vs lookup table**
`employment_records.role` is TEXT (free-form job title, e.g. "Harvester").
Note: this is distinct from security role. Should `role` reference a
lookup table to enable job-role-based reporting and filtering?
