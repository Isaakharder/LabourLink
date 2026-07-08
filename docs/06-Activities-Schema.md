# Chapter 6 — Activity Schema Design

**Status:** Implemented in migration 004
**Migration:** `database/migrations/004_activity_domain.sql`

---

## Table List

Tables are listed in dependency order.

| # | Table | Category | Description |
|---|---|---|---|
| 1 | `units` | Master (seeded) | Measurement units used as defaults on activities and registrations |
| 2 | `activity_groups` | Master (seeded) | Organisational groups shown in the mobile activity picker |
| 3 | `activities` | Master (seeded) | The catalogue of work types an employee can register against |

---

## Table Definitions

---

### `units`

Measurement units that describe what is counted in a work registration —
hours worked, pieces harvested, kilograms packed, and so on. Managed via
configuration. Cannot be hard-deleted once referenced by a registration.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `code` | TEXT | NO | — | Short unique identifier, e.g. `hours`, `kg` |
| `name` | TEXT | NO | — | Display name, e.g. `Hours`, `Kilograms` |
| `sort_order` | INTEGER | NO | 0 | Controls dropdown display order |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete; prevents use on new activities |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (code)`

**Seed data:**

| sort_order | code | name |
|---|---|---|
| 1 | `hours` | Hours |
| 2 | `pieces` | Pieces |
| 3 | `kg` | Kilograms |
| 4 | `boxes` | Boxes |
| 5 | `plants` | Plants |
| 6 | `rows` | Rows |
| 7 | `carriers` | Carriers |

---

### `activity_groups`

Groups that organise activities in the mobile activity picker. Each group
appears as a section header in the picker list. Sort order controls the
section sequence.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `name` | TEXT | NO | — | System name, unique |
| `display_name` | TEXT | YES | — | Localized name shown in UI; falls back to `name` when NULL |
| `sort_order` | INTEGER | NO | 0 | Controls section display order in mobile picker |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:** `UNIQUE (name)`

**Seed data:**

| sort_order | name | display_name |
|---|---|---|
| 1 | Greenhouse Jobs | Greenhouse Jobs |
| 2 | Warehouse Jobs | Warehouse Jobs |
| 3 | Scout | Scout |
| 4 | Breaks | Breaks |
| 5 | General | General |

---

### `activities`

The catalogue of work types an employee can register against.
All columns except `code`, `name`, and `activity_group_id` are optional.
The `requires_*` flags default to FALSE; only flags that are TRUE drive
additional input fields in the mobile registration flow.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `code` | TEXT | NO | — | 1–8 uppercase letters/digits; unique; admin-defined |
| `name` | TEXT | NO | — | Internal system name |
| `display_name` | TEXT | YES | — | Localized name shown to employees; falls back to `name` when NULL |
| `activity_group_id` | INTEGER | NO | — | FK → `activity_groups.id` |
| `default_unit_id` | INTEGER | YES | — | FK → `units.id`; suggestion only — registration may override |
| `icon` | TEXT | YES | — | Lucide icon name, e.g. `scissors`, `truck`, `leaf` |
| `color` | TEXT | YES | — | Hex color for UI display, e.g. `#10B981` |
| `requires_location` | BOOLEAN | NO | FALSE | TRUE = employee must select a location before saving |
| `requires_carrier` | BOOLEAN | NO | FALSE | TRUE = employee must select a carrier before saving |
| `requires_yield` | BOOLEAN | NO | FALSE | TRUE = employee must enter a yield quantity before saving |
| `requires_crop` | BOOLEAN | NO | FALSE | TRUE = employee must select a crop/variety before saving |
| `requires_note` | BOOLEAN | NO | FALSE | Reserved — not active yet |
| `requires_photo` | BOOLEAN | NO | FALSE | Reserved — not active yet |
| `requires_question` | BOOLEAN | NO | FALSE | Reserved — not active yet |
| `visible_on_mobile` | BOOLEAN | NO | TRUE | FALSE = hidden from employee picker; supervisors may still assign |
| `sort_order` | INTEGER | NO | 0 | Controls order within group in mobile picker |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete; preserves all historical registration references |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | |

**Constraints:**
- `UNIQUE (code)` — `activities_code_key`
- `CHECK (code ~ '^[A-Z0-9]{1,8}$')` — `activities_code_format`; enforced at DB and API
- `FOREIGN KEY (activity_group_id) REFERENCES activity_groups (id)`

**Seed data:**

| code | name | group | unit | icon | color | req_loc | req_crop | req_yield | mobile |
|---|---|---|---|---|---|---|---|---|---|
| `HARV` | Harvest | Greenhouse Jobs | pieces | scissors | #10B981 | — | ✓ | ✓ | ✓ |
| `THIN` | Thinning | Greenhouse Jobs | hours | filter | #6366F1 | — | ✓ | — | ✓ |
| `PRUNE` | Pruning | Greenhouse Jobs | hours | scissors | #8B5CF6 | — | ✓ | — | ✓ |
| `CLIP` | Clipping/Stringing | Greenhouse Jobs | hours | link | #F59E0B | — | ✓ | — | ✓ |
| `DEFOL` | Defoliation | Greenhouse Jobs | hours | leaf | #84CC16 | — | ✓ | — | ✓ |
| `TRANS` | Transplanting | Greenhouse Jobs | hours | move | #14B8A6 | — | ✓ | — | ✓ |
| `SPRAY` | Spraying | Greenhouse Jobs | hours | droplet | #3B82F6 | — | ✓ | — | ✓ |
| `PACK` | Packing | Warehouse Jobs | pieces | package | #F97316 | — | — | — | ✓ |
| `GRADE` | Grading | Warehouse Jobs | pieces | sliders | #EF4444 | — | — | — | ✓ |
| `SORT` | Sorting | Warehouse Jobs | hours | list-filter | #A78BFA | — | — | — | ✓ |
| `LOAD` | Loading | Warehouse Jobs | hours | truck | #78716C | — | — | — | ✓ |
| `SCOUT` | Scouting/Inspection | Scout | hours | search | #0EA5E9 | ✓ | ✓ | — | ✓ |
| `BREAK` | Break | Breaks | hours | coffee | #D97706 | — | — | — | ✓ |
| `LUNCH` | Lunch Break | Breaks | hours | utensils | #B45309 | — | — | — | ✓ |
| `CLEAN` | Cleaning | General | hours | sparkles | #06B6D4 | — | — | — | ✓ |
| `MAINT` | Maintenance | General | hours | wrench | #64748B | — | — | — | — |
| `MEET` | Meeting | General | hours | users | #7C3AED | — | — | — | — |
| `TRAIN` | Training | General | hours | book-open | #0D9488 | — | — | — | ✓ |

> `MAINT` and `MEET` have `visible_on_mobile = FALSE`. They do not appear in the
> employee's activity picker. Supervisors and managers may assign them manually.

---

## Relationships

```
units
 └──< activities                   (activities.default_unit_id)

activity_groups
 └──< activities                   (activities.activity_group_id)

activities
 └──< registrations  [Chapter 7]   (registrations.activity_id)
```

---

## Indexes

### `units`
```sql
UNIQUE (code)
INDEX (archived_at)
```

### `activity_groups`
```sql
UNIQUE (name)
```

### `activities`
```sql
UNIQUE (code)                                -- activities_code_key
CHECK (code ~ '^[A-Z0-9]{1,8}$')            -- activities_code_format
INDEX (activity_group_id)
INDEX (archived_at)

-- Mobile list query: active, visible, ordered within group
INDEX (activity_group_id, sort_order)
  WHERE (archived_at IS NULL AND visible_on_mobile = TRUE)
  -- activities_mobile_list
```

---

## Constraints

| Table | Constraint | Type | Rule |
|---|---|---|---|
| `units` | `units_code_key` | UNIQUE | `code` is unique |
| `activity_groups` | `activity_groups_name_key` | UNIQUE | `name` is unique |
| `activities` | `activities_code_key` | UNIQUE | `code` is unique |
| `activities` | `activities_code_format` | CHECK | `code ~ '^[A-Z0-9]{1,8}$'` |

---

## Soft Delete / Archive Approach

All three tables use `archived_at TIMESTAMPTZ`:

```
Active:   archived_at IS NULL
Archived: archived_at IS NOT NULL
```

Archiving does not cascade. If an `activity_group` is archived, its
activities are not automatically archived. If a `unit` is archived, existing
activities that reference it are not affected — the unit row remains and
historical accuracy is preserved. Archiving only prevents new selections in
dropdown menus.

---

## Current-Record Rules

| What | Condition |
|---|---|
| Active units | `archived_at IS NULL` |
| Active groups | `archived_at IS NULL` |
| Active activities | `archived_at IS NULL` |
| Mobile picker list | `archived_at IS NULL AND visible_on_mobile = TRUE ORDER BY sort_order` |
| Activities in a group | `activity_group_id = X AND archived_at IS NULL ORDER BY sort_order` |

---

## Resolved Questions

**Q1 — Single display_name vs. multi-language translations: RESOLVED**
`display_name TEXT` on each table. One translated name per entity, set by
a manager. A separate translations table is deferred until multi-language
support is explicitly required.

**Q2 — Unit storage — text vs. FK: RESOLVED**
`units` master table with FK `default_unit_id` on activities. Free-text
unit values are not permitted. Seeded with 7 common greenhouse units.

**Q3 — Activity code format: RESOLVED**
User-defined, 1–8 uppercase letters/digits, enforced by `CHECK (code ~ '^[A-Z0-9]{1,8}$')`.
API validates the same rule before insert. Codes are immutable after first use.

**Q4 — Site-specific vs. global activities: RESOLVED**
Activities are global in v1. No `site_id` column. Add nullable `site_id` when
a concrete per-site use case is required.

**Q5 — requires_carrier column: RESOLVED**
Column present; meaning is "employee must select a carrier before saving the
registration." Exact carrier concept is designed in a later domain chapter.

**Q6 — Icon naming convention: RESOLVED**
Lucide icon names (matching the shadcn/ui icon set already in the frontend).
No DB-level validation of icon names; display falls back gracefully if the
named icon does not exist.

**Q7 — visible_on_mobile = FALSE enforcement: RESOLVED**
The mobile API's activity-list endpoint filters `WHERE visible_on_mobile = TRUE`.
Supervisors and managers may manually assign hidden activities to an employee
via the web dashboard (future admin-assign flow).
