# Activity Domain

## Overview

An activity is a named unit of work that an employee can be registered
against during a shift. Activities are master data — they are defined once
by a manager and referenced many times by work registrations.

The Activity domain covers the catalogue of available activities and the
groups they belong to. It does not cover work registrations (when and by
whom an activity was performed) — those belong to the Input domain.

---

## Domain Decisions

### Activity as Master Data

**1. Activities are configuration, not events.**
An activity row describes what a task *is* — its name, group, unit, and
input requirements. It does not describe when it was performed or by whom.
The separation follows ADR-004: master data defines the nouns, event data
records the verbs.

**2. Activities are global across all sites.**
In v1, one activity catalogue applies to all greenhouse sites. If sites
need different activities in the future, a nullable `site_id` column can be
added. The current design does not close that door.

**3. Activities are never hard-deleted.**
Any activity that has ever been referenced by a work registration must
remain in the database so historical records remain valid. Retiring an
activity sets `archived_at`; the row is never removed. This follows the
"nothing important is deleted" principle (ADR-003).

---

### Activity Codes

**4. Activity codes are user-defined, not sequence-generated.**
A code like `HARV` or `PRUNE` is more readable on exports and reports than
`ACT-0001`. Codes are set by a manager at creation time and cannot be changed
after use (a rename would invalidate any export or report that referenced
the old code).

**5. Code format is enforced at both the database and API layer.**
The database CHECK constraint enforces `^[A-Z0-9]{1,8}$` — 1 to 8 uppercase
letters or digits, no spaces or special characters. The API validates the
same rule before attempting an insert.

---

### Activity Groups

**6. Every activity belongs to exactly one group.**
Activity groups exist to organise the mobile activity-picker into logical
sections. An activity cannot exist without a group. Groups are also master
data and follow the same soft-delete rules as activities.

**7. Groups seed on migration; managers may add more.**
Five groups ship with the system: Greenhouse Jobs, Warehouse Jobs, Scout,
Breaks, and General. Additional groups can be added via configuration.
The `sort_order` column controls the order they appear in the app.

---

### Mobile Visibility

**8. `visible_on_mobile` controls self-service availability.**
When `visible_on_mobile = FALSE`, an activity does not appear in the
employee's activity-picker on the mobile app. This does not prevent the
activity from existing or from being assigned by a supervisor or manager.
A future "assign activity to employee" flow may use hidden activities for
scheduled or maintenance tasks.

---

### Required Fields (Input Gates)

**9. `requires_*` flags drive mobile form behaviour.**
Each flag tells the mobile app that a specific piece of information must be
collected before the activity registration is saved. The flags are stored on
the activity so that configuration changes take effect immediately without a
code change.

Current flags:

| Flag | When TRUE |
|---|---|
| `requires_location` | Employee must select a row/location |
| `requires_carrier` | Employee must select a carrier |
| `requires_yield` | Employee must enter a yield quantity |
| `requires_crop` | Employee must select a crop/variety |
| `requires_note` | Employee must enter a text note |
| `requires_photo` | Employee must attach a photo |
| `requires_question` | Employee must answer a configured question |

Note, photo, and question flags are reserved for future use. They are
present in the schema now to avoid an ALTER TABLE later.

---

### Units

**10. `default_unit_id` is a FK to the `units` table, not free text.**
Free-text unit values cannot be filtered, compared, or reported on reliably.
The `units` table is a small master table managed by configuration.
The `default_unit_id` on an activity is a suggestion; the registration may
override it if the input form allows it.

**11. Units follow the same soft-delete pattern as activities.**
Retiring a unit sets `archived_at`. Historical registrations that referenced
the unit remain valid.

---

### Icons

**12. The `icon` column stores Lucide icon names.**
The frontend stack uses Lucide via shadcn/ui. Icon values are the string
name as used by the Lucide library (e.g. `scissors`, `truck`, `leaf`).
This is a display hint only — the API and database do not validate that the
named icon exists in the library.

---

## Data Model (outline)

| Entity | Category | Description |
|---|---|---|
| `units` | Master (seeded) | Measurement units referenced by activities and registrations |
| `activity_groups` | Master (seeded) | Named groups that organise activities in the mobile picker |
| `activities` | Master (seeded) | The catalogue of work types employees can register against |

---

## Activity Lifecycle

```
Created → Active (visible in picker) → Archived (hidden, history preserved)
```

An activity is never deleted. When a manager retires an activity, `archived_at`
is set. It disappears from the active catalogue and the mobile picker, but all
historical registrations that referenced it remain intact.

---

## Relationship to Other Domains

| Domain | Relationship |
|---|---|
| Input | Work registrations reference `activities.id` |
| Locations | `requires_location = TRUE` triggers a location picker in the mobile registration form |
| Carriers | `requires_carrier = TRUE` triggers a carrier picker — carrier domain is designed later |
| Greenhouse View | Row state (blue/green/yellow) is derived from work events that reference `activities` |
| Reports | Payroll and productivity output joins registrations to `activities` at event time |
