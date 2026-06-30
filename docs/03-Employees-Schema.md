# Chapter 3 — Employee Schema Design

**Status:** Implemented in migration 002
**Migration:** `database/migrations/002_employee_domain.sql`

---

## Table List

Tables are listed in dependency order (each table may only reference tables above it).

| # | Table | Category | Description |
|---|---|---|---|
| 1 | `companies` | Master | Root anchor; one company per installation |
| 2 | `sites` | Master | Greenhouse sites belonging to the company |
| 3 | `security_roles` | Master (seeded) | System access roles; seeded on first migration |
| 4 | `job_roles` | Master (seeded) | Job titles used in employment records; seeded on first migration |
| 5 | `teams` | Master | Named groups of employees, scoped to a site |
| 6 | `contract_templates` | Master (stub) | Pay and hour definitions; full design in Chapter 4 |
| 7 | `employees` | Master | Person identity; never deleted |
| 8 | `employee_sensitive_data` | Master (restricted) | National ID / BSN; access-controlled separately |
| 9 | `employee_credentials` | Master (restricted) | Hashed PINs; access-controlled separately from identity |
| 10 | `employee_security_role_assignments` | History | Active and historical role assignments per employee |
| 11 | `employment_records` | Versioned master | Effective employment: site, job role, team, contract, supervisor |
| 12 | `devices` | Master | Registered Android phones |
| 13 | `device_assignments` | History | Which employee holds a device; append-only |
| 14 | `device_login_history` | Event | Every login event on any device; append-only |

> `contract_templates`, `employees`, and `employment_history` (placeholder) were created in
> migration 001 as stubs. All three are dropped and recreated in migration 002.

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

Security role is distinct from job role. Security role determines system
permissions. Job role (e.g. "Harvester") is a separate concept held in
`employment_records.job_role_id → job_roles`.

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

**Seed data:**

| sort_order | name | description | is_default |
|---|---|---|---|
| 1 | General | Regular employee — mobile clock-in/clock-out only | TRUE |
| 2 | Crew Leader | Can view team registrations and close shifts for others | FALSE |
| 3 | Supervisor | Can manage employees and registrations within their site | FALSE |
| 4 | Manager | Can manage all data including contracts and locations | FALSE |
| 5 | Admin | Full system access including configuration and user management | FALSE |

> Permission boundaries per role are enforced at the API level, not in the database.

---

### `job_roles`

Predefined job titles that may be assigned to an employee via `employment_records`.
Free-text job titles are not permitted; all values must exist in this table.
Seeded by migration with common greenhouse roles. Managers may add new rows
via configuration.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `name` | TEXT | NO | — | Display name |
| `sort_order` | INTEGER | NO | 0 | Controls dropdown display order |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete; prevents use on new records, preserves history |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (name)`

**Seed data:**

| sort_order | name |
|---|---|
| 1 | General |
| 2 | Harvester |
| 3 | Packer |
| 4 | Grader |
| 5 | Driver |
| 6 | Supervisor |
| 7 | Manager |

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

Security role is **not** stored here — it lives in `employee_security_role_assignments`.
Job role is **not** stored here — it lives in `employment_records.job_role_id`.
National ID / BSN is **not** stored here — it lives in `employee_sensitive_data`.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_number` | TEXT | NO | — | Auto-generated `EMP-0001` format; company-scoped; immutable |
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

> `employee_number` is generated by the API using the `employee_number_seq` sequence:
> `'EMP-' || LPAD(nextval('employee_number_seq')::text, 4, '0')`
> It is set once at creation and never updated.

---

### `employee_sensitive_data`

Stores national ID numbers (BSN or equivalent) separately from general
identity data. Row is created only when national ID information is provided
(not guaranteed to exist for every employee). Access is restricted to the
Admin and Manager security roles at the API level.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_id` | INTEGER | NO | — | FK → `employees.id` |
| `national_id_number` | TEXT | YES | — | BSN or equivalent national identifier |
| `national_id_country` | TEXT | YES | — | ISO 3166-1 alpha-2 country code, e.g. `NL` |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (employee_id)` — one row per employee at most

---

### `employee_credentials`

Stores hashed PINs for employees who require device-level authentication
(Crew Leader and above). Kept separate from `employees` to allow tighter
API-level access control on credential data.

PINs are **never** stored in plaintext. Only a bcrypt or Argon2id hash is
stored. The plaintext PIN is discarded immediately after hashing at the API.

A row is created for every employee at creation time (`pin_hash = NULL`),
avoiding nullable LEFT JOINs when checking credential status.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_id` | INTEGER | NO | — | FK → `employees.id` |
| `pin_hash` | TEXT | YES | NULL | Hashed PIN; NULL if no PIN has been set |
| `pin_set_at` | TIMESTAMPTZ | YES | NULL | Timestamp of last PIN change |
| `pin_set_by` | INTEGER | YES | — | FK → `employees.id`; admin who set the PIN |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (employee_id)`

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

**Constraints:** `UNIQUE (employee_id) WHERE (ended_at IS NULL)`

> No `updated_at` — rows are never modified after creation.
> When an employee is created, a role assignment is immediately inserted
> using either the selected role or the `is_default = TRUE` role (General).

---

### `employment_records`

Effective employment record linking an employee to a site, job role, team,
contract, and supervisor for a defined date range.

Replaces the placeholder `employment_history` table from migration 001.
One record per employee may have `ended_on IS NULL` at a time.

Job role is a foreign key to `job_roles`. Free-text roles are not permitted.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `employee_id` | INTEGER | NO | — | FK → `employees.id` |
| `site_id` | INTEGER | NO | — | FK → `sites.id`; primary site for this employment |
| `job_role_id` | INTEGER | YES | — | FK → `job_roles.id`; no free-text roles |
| `contract_template_id` | INTEGER | YES | — | FK → `contract_templates.id` |
| `team_id` | INTEGER | YES | — | FK → `teams.id` |
| `supervisor_id` | INTEGER | YES | — | FK → `employees.id`; self-referential |
| `started_on` | DATE | NO | — | First effective date of this record |
| `ended_on` | DATE | YES | NULL | NULL = currently active; set when superseded |
| `notes` | TEXT | YES | — | Reason for change or other context |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `created_by` | INTEGER | YES | — | FK → `employees.id`; who created the record |

**Constraints:**
- `UNIQUE (employee_id) WHERE (ended_on IS NULL)` — one active record per employee
- `CHECK (ended_on IS NULL OR ended_on > started_on)` — valid date range
- `CHECK (supervisor_id IS NULL OR supervisor_id != employee_id)` — no self-supervision

> No `updated_at` — append-only. To change: set `ended_on` on the current row,
> insert a new row. Both in one transaction.

---

### `devices`

Android phones registered to the LabourLink system.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `site_id` | INTEGER | NO | — | FK → `sites.id`; home site of the device |
| `name` | TEXT | NO | — | Human-readable label, e.g. `Phone 3 — GH-A` |
| `identifier` | TEXT | NO | — | LabourLink-generated UUID; stored in app secure storage |
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

---

### `device_login_history`

Records every login event on any device — shared and assigned alike.
Append-only. Full audit coverage regardless of device type.

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

job_roles
 └──< employment_records                 (employment_records.job_role_id)

teams
 └──< employment_records                 (employment_records.team_id)

contract_templates
 └──< employment_records                 (employment_records.contract_template_id)

employees
 ├──< employee_sensitive_data            (esd.employee_id)              [1:0..1]
 ├──< employee_credentials               (ec.employee_id)               [1:1]
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

### `job_roles`
```sql
UNIQUE (name)
```

### `teams`
```sql
INDEX (site_id)
UNIQUE (site_id, name)
```

### `employees`
```sql
UNIQUE (employee_number)
INDEX (archived_at)
INDEX (last_name)
```

### `employee_sensitive_data`
```sql
UNIQUE (employee_id)
```

### `employee_credentials`
```sql
UNIQUE (employee_id)
```

### `employee_security_role_assignments`
```sql
UNIQUE (employee_id) WHERE (ended_at IS NULL)   -- one active role per employee
INDEX (employee_id, started_at)                  -- role history per employee
INDEX (security_role_id) WHERE (ended_at IS NULL) -- employees currently in a role
```

### `employment_records`
```sql
UNIQUE (employee_id) WHERE (ended_on IS NULL)   -- one active record per employee
INDEX (employee_id, started_on)                  -- history per employee
INDEX (site_id)                                  -- employees at a site
INDEX (team_id)                                  -- employees in a team
INDEX (job_role_id)                              -- employees by job role
```

### `devices`
```sql
UNIQUE (identifier)
INDEX (site_id)
INDEX (archived_at)
```

### `device_assignments`
```sql
UNIQUE (device_id) WHERE (ended_at IS NULL)     -- one active assignment per device
INDEX (device_id, started_at)                    -- assignment history per device
INDEX (employee_id)                              -- devices ever assigned to employee
```

### `device_login_history`
```sql
INDEX (device_id, logged_in_at)
INDEX (employee_id, logged_in_at)
INDEX (device_id) WHERE (logged_out_at IS NULL)  -- open sessions
```

---

## Constraints

| Table | Constraint | Type | Rule |
|---|---|---|---|
| `sites` | `sites_company_code_key` | UNIQUE | `(company_id, code)` — codes unique per company |
| `security_roles` | `security_roles_name_key` | UNIQUE | `name` is unique |
| `security_roles` | `security_roles_one_default` | PARTIAL UNIQUE | `(is_default) WHERE is_default = TRUE` |
| `job_roles` | `job_roles_name_key` | UNIQUE | `name` is unique |
| `teams` | `teams_site_name_key` | UNIQUE | `(site_id, name)` — team names unique per site |
| `employees` | `employees_number_key` | UNIQUE | `employee_number` is unique |
| `employee_sensitive_data` | `esd_employee_key` | UNIQUE | One row per employee at most |
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

Tables: `companies`, `sites`, `security_roles`, `job_roles`, `teams`,
`employees`, `employee_sensitive_data`, `employee_credentials`,
`contract_templates`, `devices`

Soft-deleted via `archived_at TIMESTAMPTZ`.

```
Active:   archived_at IS NULL
Archived: archived_at IS NOT NULL
```

Archiving never cascades. All historical foreign key references remain intact.
Archiving a `job_role` or `security_role` prevents new assignments but preserves
all historical records that referenced it.

### Versioned master data

Tables: `employment_records`, `employee_security_role_assignments`

No `archived_at`. Lifecycle is managed through `(started_on/at, ended_on/at)`.

To change a versioned record:
1. Set `ended_on` / `ended_at` on the current row
2. Insert the new row with `ended_on` / `ended_at = NULL`
Both in one transaction. Old row is never modified further.

### Append-only tables

Tables: `device_assignments`, `device_login_history`

No delete mechanism. Rows accumulate indefinitely.

---

## Current-Record Rules

| What | Condition |
|---|---|
| Active companies | `archived_at IS NULL` |
| Active sites | `archived_at IS NULL` |
| Active security roles | `archived_at IS NULL` |
| Active job roles | `archived_at IS NULL` |
| Active employees | `archived_at IS NULL` |
| Current security role for employee X | `employee_id = X AND ended_at IS NULL` |
| Current employment record for employee X | `employee_id = X AND ended_on IS NULL` |
| Current device assignment for device D | `device_id = D AND ended_at IS NULL` |
| Open login session for device D | `device_id = D AND logged_out_at IS NULL` |

---

## Employee Creation Flow

When creating a new employee, the following rows are inserted in one transaction:

1. **`employees`** — identity record (employee_number generated from sequence)
2. **`employee_sensitive_data`** — only if national ID is provided at creation time
3. **`employee_credentials`** — one row with `pin_hash = NULL`
4. **`employee_security_role_assignments`** — one row using the selected security role,
   or the `is_default = TRUE` role (General) if none was selected

The Security Role dropdown is populated from:
`security_roles WHERE archived_at IS NULL ORDER BY sort_order`

The Job Role dropdown (on employment_records) is populated from:
`job_roles WHERE archived_at IS NULL ORDER BY sort_order`

---

## Resolved Questions

**Q1 — Employee number format: RESOLVED**
Auto-generated, sequential, company-scoped, immutable. Format: `EMP-0001`.
Generated by the API via PostgreSQL sequence `employee_number_seq`.
Never changes after creation.

**Q2 — Multi-site employment model: RESOLVED**
One active `employment_record` per employee, enforced by partial unique
constraint. Primary site is the employment record's `site_id`. Cross-site
work is tagged at registration time; no second employment record needed.

**Q3 — Supervisor scope: RESOLVED**
No database-level constraint on supervisor site scope. Enforced at the
app level only. The supervisor dropdown defaults to same-site employees
for convenience but does not restrict cross-site supervisors.

**Q4 — Team scope: RESOLVED**
Teams are site-specific (`teams.site_id`). A cross-site team has no
concrete use case and can be revisited if one emerges.

**Q5 — Device identifier: RESOLVED**
LabourLink generates a UUID on first app launch, stored in Android Keystore.
Factory reset requires admin re-registration; old device row is archived.

**Q6 — Login history scope: RESOLVED**
Every login on every device is recorded in `device_login_history`,
regardless of whether the device is shared or assigned.

**Q7 — Sensitive personal data: RESOLVED**
National ID / BSN is stored in the separate `employee_sensitive_data` table.
Access restricted to Admin and Manager security roles at the API level.

**Q8 — Job role as text vs lookup table: RESOLVED**
`employment_records.job_role_id` is a FK to the `job_roles` table.
Free-text roles are not permitted. Seeded with 7 common greenhouse job titles.
