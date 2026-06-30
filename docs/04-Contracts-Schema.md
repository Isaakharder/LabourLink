# Chapter 4 — Contract Domain Schema Design

**Status:** Design — not yet implemented

---

## Naming

| Context | Name |
|---|---|
| Database table | `contract_templates` |
| UI / user-facing | Contracts |

`contract_templates` was created as a stub in migration 002. Chapter 4 alters
and extends it. All foreign key references in other tables (e.g.
`employment_records.contract_template_id`) remain unchanged.

---

## Table List

| # | Table | Type | Description |
|---|---|---|---|
| 1 | `contract_templates` | Master | A named set of pay rules; UI calls these "Contracts" |
| 2 | `contract_profiles` | Versioned | The effective rules for a date range under one Contract |
| 3 | `contract_profile_break_rules` | Child | Break tiers belonging to a profile |
| 4 | `contract_profile_daily_ot_tiers` | Child | Daily overtime tiers belonging to a profile |
| 5 | `contract_profile_weekly_ot_tiers` | Child | Weekly overtime tiers belonging to a profile |

---

## Table Definitions

---

### 1. `contract_templates`

**UI name:** Contracts

**Purpose:** Master list of contracts. A contract is a named configuration
that can be assigned to many employees via `employment_records`. The table
was created as a stub in migration 002; this migration adds the `is_active`
flag and a `UNIQUE (name)` constraint.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `name` | TEXT | NO | — | Display name shown in dropdowns and the contract list |
| `is_active` | BOOLEAN | NO | TRUE | FALSE = no new assignments allowed; existing records unaffected |
| `archived_at` | TIMESTAMPTZ | YES | NULL | Soft delete — hides the contract from all views |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `updated_at` | TIMESTAMPTZ | NO | NOW() | Managed by trigger |

**Constraints:**
```
UNIQUE (name)
```

**Notes:**
- `is_active = FALSE` means the contract is visible but not selectable for new
  employment records. Use this when a contract is being phased out but
  employees are still assigned to it.
- `archived_at IS NOT NULL` means the contract is hidden from all lists.
  A contract should be archived only when it is no longer needed for any view.

---

### 2. `contract_profiles`

**Purpose:** A versioned snapshot of the rules that apply to a contract
from `start_date` onwards. When any rule changes, a new profile is created.
The old profile is closed by setting its `ended_on`. Past registrations
always resolve the profile active on their work date; new profiles never
alter historical calculations.

One row = one effective rule set for one date range under one contract.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `contract_id` | INTEGER | NO | — | FK → contract_templates.id |
| `start_date` | DATE | NO | — | First date this profile is in effect |
| `ended_on` | DATE | YES | NULL | Exclusive end date; set to new profile's start_date when superseded. NULL = current or future |
| `created_at` | TIMESTAMPTZ | NO | NOW() | |
| `created_by` | INTEGER | YES | NULL | FK → employees.id — who created this profile |
| | | | | |
| **General** | | | | |
| `description` | TEXT | YES | NULL | Free-text note on what changed in this profile version |
| `pay_period_type` | TEXT | NO | 'weekly' | Controls the payroll cycle. See allowed values below |
| | | | | |
| **Work Start Time** | | | | |
| `work_day_start_time` | TIME | NO | '00:00' | Day boundary for overnight shift classification. A registration starting before this time belongs to the previous calendar day |
| | | | | |
| **Public Holidays** | | | | |
| `public_holiday_multiplier` | NUMERIC(4,2) | NO | 1.00 | Pay multiplier on public holidays (1.00 = normal rate, 2.00 = double pay) |
| `public_holidays_count_for_overtime` | BOOLEAN | NO | FALSE | If TRUE, public holiday hours are included in weekly overtime totals |
| | | | | |
| **Wages** | | | | |
| `base_hourly_rate` | NUMERIC(10,4) | NO | — | Gross hourly rate in local currency. No default — must be set explicitly on every profile |
| | | | | |
| **Work Hours** | | | | |
| `standard_hours_per_day` | NUMERIC(5,2) | NO | 8.00 | Normal working hours per day. Overtime applies after this threshold |
| `standard_hours_per_week` | NUMERIC(5,2) | NO | 40.00 | Normal working hours per week. Weekly OT applies after this threshold |

**Constraints:**
```sql
UNIQUE (contract_id, start_date)
CHECK (ended_on IS NULL OR ended_on >= start_date)
CHECK (pay_period_type IN ('weekly', 'bi_weekly', 'four_weekly', 'monthly'))
CHECK (base_hourly_rate > 0)
CHECK (standard_hours_per_day > 0)
CHECK (standard_hours_per_week > 0)
CHECK (public_holiday_multiplier >= 0)
```

**Resolving the active profile for a work date:**
```sql
SELECT *
FROM contract_profiles
WHERE contract_id = :contract_id
  AND start_date  <= :work_date
  AND (ended_on IS NULL OR ended_on > :work_date)
ORDER BY start_date DESC
LIMIT 1;
```

**Indexes:**
```sql
-- Fast profile resolution for payroll (most common query path)
CREATE INDEX ON contract_profiles (contract_id, start_date DESC);
-- List all profiles for a contract in UI
CREATE INDEX ON contract_profiles (contract_id, start_date);
```

---

### 3. `contract_profile_break_rules`

**Purpose:** Break tiers for a profile. Multiple rows per profile are
ordered by `trigger_after_hours`. The break system is informational
for v1 — the system records actual breaks taken rather than enforcing
deductions automatically.

One row = one break tier (e.g. "30 min unpaid after 6 hours worked").

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `profile_id` | INTEGER | NO | — | FK → contract_profiles.id |
| `trigger_after_hours` | NUMERIC(5,2) | NO | — | Hours worked before this break is triggered (e.g. 6.00) |
| `duration_minutes` | INTEGER | NO | — | Duration of the break in minutes (e.g. 30) |
| `is_paid` | BOOLEAN | NO | FALSE | TRUE = paid break; FALSE = unpaid (deducted from worked hours) |
| `sort_order` | INTEGER | NO | 0 | Display order in UI; processing order in payroll |

**Constraints:**
```sql
CHECK (trigger_after_hours > 0)
CHECK (duration_minutes > 0)
```

**Index:**
```sql
CREATE INDEX ON contract_profile_break_rules (profile_id, sort_order);
```

**Example — two-tier break rule:**

| sort_order | trigger_after_hours | duration_minutes | is_paid |
|---|---|---|---|
| 1 | 6.00 | 30 | FALSE |
| 2 | 9.00 | 15 | TRUE |

---

### 4. `contract_profile_daily_ot_tiers`

**Purpose:** Daily overtime rate tiers. When hours worked in a single
calendar day (as defined by `work_day_start_time`) exceed `threshold_hours`,
the multiplier in that tier applies to hours worked beyond the threshold.

Tiers are ordered by `threshold_hours` ascending. The highest threshold
not yet exceeded determines the current tier.

One row = one daily overtime tier (e.g. "1.25× after 8h, 1.5× after 10h").

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `profile_id` | INTEGER | NO | — | FK → contract_profiles.id |
| `threshold_hours` | NUMERIC(5,2) | NO | — | Total daily hours worked before this multiplier applies (e.g. 8.00) |
| `multiplier` | NUMERIC(4,2) | NO | — | Pay multiplier for hours worked beyond the threshold (e.g. 1.25) |
| `sort_order` | INTEGER | NO | 0 | Processing order; lower sort_order = lower tier |

**Constraints:**
```sql
CHECK (threshold_hours > 0)
CHECK (multiplier > 0)
```

**Index:**
```sql
CREATE INDEX ON contract_profile_daily_ot_tiers (profile_id, sort_order);
```

**Example — two-tier daily OT:**

| sort_order | threshold_hours | multiplier | Meaning |
|---|---|---|---|
| 1 | 8.00 | 1.25 | First OT tier: 1.25× from hour 8 to hour 10 |
| 2 | 10.00 | 1.50 | Second OT tier: 1.50× from hour 10 onwards |

---

### 5. `contract_profile_weekly_ot_tiers`

**Purpose:** Weekly overtime rate tiers. When total hours worked in a pay
week exceed `threshold_hours`, the multiplier in that tier applies. The week
boundary is determined by `pay_period_type` on the profile.

Same structure as daily OT tiers, operating over a week rather than a day.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | SERIAL | NO | — | Primary key |
| `profile_id` | INTEGER | NO | — | FK → contract_profiles.id |
| `threshold_hours` | NUMERIC(5,2) | NO | — | Total weekly hours before this multiplier applies (e.g. 40.00) |
| `multiplier` | NUMERIC(4,2) | NO | — | Pay multiplier for hours worked beyond the threshold (e.g. 1.25) |
| `sort_order` | INTEGER | NO | 0 | Processing order; lower sort_order = lower tier |

**Constraints:**
```sql
CHECK (threshold_hours > 0)
CHECK (multiplier > 0)
```

**Index:**
```sql
CREATE INDEX ON contract_profile_weekly_ot_tiers (profile_id, sort_order);
```

**Example — two-tier weekly OT:**

| sort_order | threshold_hours | multiplier | Meaning |
|---|---|---|---|
| 1 | 40.00 | 1.25 | 1.25× from hour 40 to hour 48 |
| 2 | 48.00 | 1.50 | 1.50× above hour 48 |

---

## Relationships

```
contract_templates (Contracts)
  │
  ├── employment_records.contract_template_id    (Chapter 3, many employees → one contract)
  │
  └── contract_profiles  [1..* per contract]
        │
        ├── contract_profile_break_rules         [0..* per profile]
        ├── contract_profile_daily_ot_tiers      [0..* per profile]
        └── contract_profile_weekly_ot_tiers     [0..* per profile]
```

Payroll lookup chain:
```
registration.work_date
  → employment_records.contract_template_id (active on work_date)
  → contract_profiles (start_date ≤ work_date, ordered DESC, LIMIT 1)
  → break_rules + daily_ot_tiers + weekly_ot_tiers for that profile
```

---

## Soft Delete and Archive Approach

| Entity | Soft Delete Column | Meaning |
|---|---|---|
| `contract_templates` | `archived_at` | Hidden from all UI; no new assignments |
| `contract_profiles` | `ended_on` | Profile has been superseded; kept for historical payroll |
| Break / OT tier tables | — (none) | Tiers are owned by a profile; they persist as long as the profile exists |

Child tables (break rules, OT tiers) are never individually deleted.
If a new profile removes a break rule, the old profile retains its tiers
and the new profile simply has no row in `contract_profile_break_rules`.

---

## Current-Record Rules

| Table | Current-record definition |
|---|---|
| `contract_templates` | `archived_at IS NULL AND is_active = TRUE` |
| `contract_profiles` | `ended_on IS NULL` (or `ended_on > CURRENT_DATE`) |

There is intentionally no `UNIQUE (contract_id) WHERE ended_on IS NULL`
constraint on `contract_profiles`. A contract may have one profile ending
today and a new profile starting tomorrow — both with `ended_on IS NULL`
simultaneously during the transition window. Uniqueness is enforced
by `UNIQUE (contract_id, start_date)` instead.

---

## Migration Approach

Migration 003 will:

1. `ALTER TABLE contract_templates ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE`
2. `ALTER TABLE contract_templates ADD CONSTRAINT contract_templates_name_key UNIQUE (name)`
3. Create `contract_profiles`
4. Create `contract_profile_break_rules`
5. Create `contract_profile_daily_ot_tiers`
6. Create `contract_profile_weekly_ot_tiers`

No data migration is needed — `contract_templates` currently has no rows.

---

## Open Questions

**Q1 — Can employees be assigned an inactive contract?**
If a contract's `is_active` is FALSE, should the system block new
`employment_records` pointing to it, or only hide it from dropdowns and
allow it via API?
*Recommended default:* Block at the API layer; hide from UI dropdowns.
DB has no constraint — the flag is advisory, enforced in application code.

**Q2 — Who defines public holidays?**
There is no `public_holidays` calendar table yet. How are public holidays
identified on a registration: a flag on the registration row, a separate
calendar table loaded per country, or something set by a manager?
*Recommended default:* Add a `public_holidays` calendar table in a later
migration (Chapter 5 or 6). For v1, a boolean flag on the registration
allows manual marking. This is an explicit open decision.

**Q3 — Do daily and weekly OT tiers interact?**
If an employee triggers both daily and weekly OT in the same day, which
takes precedence? The most common rule is: daily OT is calculated first,
then weekly OT applies to any remaining hours not already uplifted.
*Recommended default:* Daily OT is calculated first; weekly OT applies
only to base-rate hours not already uplifted by daily OT. Document this
as a calculation rule in the Input chapter.

**Q4 — Are break deductions applied before or after OT calculation?**
Unpaid break minutes are typically deducted from total worked hours before
overtime thresholds are applied.
*Recommended default:* Deduct unpaid breaks first, then apply daily OT,
then weekly OT. Document in Input chapter.

**Q5 — Can wage rates vary by day of week or time of day?**
Some contracts have weekend surcharges or evening rates. The current
`base_hourly_rate` model does not support this.
*Recommended default:* Out of scope for v1. Note as a future extension to
the Wages section. A `contract_profile_wage_bands` table can be added later.

**Q6 — Is the wage rate gross or net?**
Wage rates shown in the UI — are they gross (before tax deductions) or net?
Is tax calculation in scope for LabourLink?
*Recommended default:* Gross. LabourLink produces payroll input; tax
calculation is handled downstream.

**Q7 — What happens when an employee changes contracts mid-pay-period?**
If an employee switches from Contract A to Contract B on a Wednesday, does
the payroll calculation split the week: Mon–Tue under Contract A's profile,
Wed–Sun under Contract B's?
*Recommended default:* Yes — calculate per day using the contract effective
on that day. This is the correct approach given the event-driven design.
Document in the Input and Reporting chapters.

**Q8 — Should `work_day_start_time` be on the site rather than the profile?**
If all contracts at a site share the same work day start time, putting it on
the profile leads to repetition and risk of inconsistency.
*Recommended default:* Keep on the profile for now — it avoids a dependency
on the site record during payroll calculation and supports contracts that
span sites. Revisit if it proves consistently duplicated.
