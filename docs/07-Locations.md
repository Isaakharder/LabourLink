# Location Domain

## Overview

The Location domain defines the physical structure of the greenhouse operation —
from the top-level site down to individual plant rows. Locations are master data:
defined once by a manager, referenced many times by work registrations, mobile
scans, and the Greenhouse View map.

The central object is the **row** — the smallest scannable, trackable, reportable
unit of space. Every row that has ever had a work registration must remain in the
database permanently so that history stays intact.

---

## Domain Decisions

### Hierarchy

**1. The location hierarchy is: Site → Greenhouse → Phase → House → Row.**
Five levels, strictly ordered. Every row belongs to a house; every house belongs
to a phase; every phase belongs to a greenhouse; every greenhouse belongs to a site.

This enforced depth avoids the nullable-FK complexity of skippable levels. If a
greenhouse does not use phases in the operational sense, it still has exactly one
phase (e.g., "Phase 1") and the phase is transparent to users. The benefit is a
predictable join path from any row back to its site.

See Open Question 1 for the trade-offs of abbreviated hierarchies.

**2. Codes at each level are unique within their parent, not globally.**
A code like `R001` means Row 1 within a given house. Two houses can both have an
`R001` — the full identity of a row is its entire path
(`HQ / GH01 / PH1 / H1 / R001`). Scan codes in `row_scan_codes`, however, are
globally unique across the entire database (see Scanning below).

**3. Code format matches Activities: `^[A-Z0-9]{1,8}$`.**
Uppercase letters and digits only, 1–8 characters. Enforced by DB CHECK constraint
at every level. Consistent with Activity codes — the same constraint means the
same validation logic can be reused at the API and mobile layers.

---

### Scanning

**4. Scan codes live in a `row_scan_codes` child table, not on `rows`.**
A row can have multiple physical scan codes — a QR label at each end, an RFID chip
at the post, and a manual barcode on the tag are all valid simultaneously. Each
`row_scan_codes` row carries the actual content embedded in the label (`scan_code`),
how it is read (`scan_type`), an optional human note (`label`), and whether it is
the primary code for that row (`is_primary`).

The display `code` on `rows` (`R001`) remains short and human-readable but is only
unique within a house. `scan_code` in `row_scan_codes` is globally unique — a
mobile device can resolve any scan to its row without knowing which greenhouse it
is in.

**5. `scan_type` is NOT NULL on every scan code row.**
Every code in `row_scan_codes` must declare how it is physically read:
`qr` / `rfid` / `barcode` / `manual`. Because `scan_type` is NOT NULL, there are
no orphaned codes with unknown types. A row with no physical labels simply has no
`row_scan_codes` entries; it is found only through manual lookup.

**6. `is_primary = TRUE` marks the canonical code per row.**
One code per row is designated primary. The primary code is shown in the UI
summary card, used for label printing, and returned in list views. A partial unique
index (`WHERE is_primary = TRUE AND archived_at IS NULL`) ensures at most one active
primary per row. Non-primary codes work identically for scanning — the mobile app
resolves any active code to the same row.

---

### Map Coordinates

**7. Rows store explicit map coordinates for the Greenhouse View.**
Each row holds `map_x_m` and `map_y_m` — the position of the row's origin point
relative to the greenhouse's lower-left corner, in metres. `length_m` is the
physical length of the row in metres. `direction` is the cardinal bearing the row
runs in (north / south / east / west).

These four columns are nullable. Operators who do not need the Greenhouse View can
leave them empty. The Greenhouse View query uses them only when present, falling
back to `sort_order` for a simple grid layout.

See Open Question 3 for the choice between stored coordinates and derived positions.

**8. The greenhouse stores its map dimensions and orientation.**
`map_width_m`, `map_length_m`, and `orientation_deg` on the `greenhouses` table
define the canvas that the Greenhouse View renders. `orientation_deg` is the
compass bearing of the greenhouse's long axis (0 = North, 90 = East). These are
also nullable — the map feature is future work.

---

### Archiving

**9. No level is ever hard-deleted.**
Any location that has ever been referenced by a work registration must remain in
the database so that historical records remain valid. This applies to all five
levels. Retiring a location sets `archived_at`; the row is never removed.
This follows ADR-003: nothing important is deleted.

**10. Archiving a parent does not cascade to children at the DB layer.**
Cascade archiving (archiving a greenhouse archives all its rows) is enforced at the
API layer, not with a trigger. This keeps the database simple and auditable —
individual archived_at timestamps on each row tell you exactly when each location
was retired, regardless of whether a parent was archived first.

Historical work registrations that reference an archived row remain fully valid.
The FK from work events to `rows.id` is never removed; archived rows simply do not
appear in active list queries.

---

### Site

**11. In v1, a single site covers the whole operation.**
The schema supports multiple sites from day one (all greenhouses carry a `site_id`
FK). In practice, v1 will have exactly one site. The site's `timezone` column will
be used by the payroll and reporting domains for date boundary calculations.

**12. Activities are global; locations are per-site.**
Activity codes like HARV are the same across all sites. Row codes exist only within
a site's physical structure. There is no cross-site row sharing.

---

## Data Model (outline)

| Entity | Category | Description |
|---|---|---|
| `sites` | Master | Top-level facility; carries timezone |
| `greenhouses` | Master | Physical greenhouse building; carries map dimensions |
| `phases` | Master | Climate zone or compartment within a greenhouse |
| `houses` | Master | Bay or structural span within a phase |
| `rows` | Master | Individual plant row; primary scan and tracking unit |

---

## Location Lifecycle

```
Created → Active (visible in pickers and map) → Archived (hidden, history preserved)
```

A location at any level is never deleted. When a manager retires a location
(e.g., a row is removed, a greenhouse is demolished), `archived_at` is set.
It disappears from active pickers and the Greenhouse View map, but all
historical work registrations that referenced it remain intact.

---

## Relationship to Other Domains

| Domain | Relationship |
|---|---|
| Activities | `requires_location = TRUE` triggers a row picker in the mobile registration form |
| Input | Work registrations reference `rows.id`; the full path is derived via JOIN |
| Greenhouse View | Row state (blue/green/yellow) is queried from work events joined to `rows` |
| Crops/Varieties | Crop assignment at row level is an open question; see Open Question 4 |
| Employees | No direct FK; employees are linked to rows through work events |

---

## Open Questions

**1. Mandatory 5-level hierarchy or variable depth?**
If a greenhouse has no meaningful phase or house subdivisions, the strict hierarchy
requires creating a nominal "Phase 1" and "House 1" as transparent intermediaries.
Alternatives:
- Option A (current design): Mandate all 5 levels. Dummy intermediaries are created
  by the import wizard or setup flow. Simplest query logic.
- Option B: Allow rows to attach to a phase or greenhouse directly via nullable FKs
  on houses and rows. More flexible, messier schema.
- Option C: Self-referential `locations` table with a `type` column.
  Most flexible, hardest to enforce hierarchy rules or add level-specific columns.
Recommended: Option A unless operators actively resist creating intermediaries.

**2. Multiple scan codes per row — resolved.**
`row_scan_codes` child table added. A row can have any number of active scan codes
(QR at each end, RFID chip, manual barcode, etc.). One is marked `is_primary`.
See schema reference for the full table definition and index design.

**3. Stored coordinates vs. derived grid positions?**
The Greenhouse View map can render rows from:
- Option A: Explicit `map_x_m` / `map_y_m` per row — accurate, requires data entry.
- Option B: Computed from `sort_order` and a fixed row-width — zero data entry, but
  imprecise for irregular layouts.
- Option C: A future separate `greenhouse_layout` table — decouple layout from master data.
Recommended: Option A (stored coordinates), left nullable until the Greenhouse View
is actually built. At that point the import/setup tool populates them.

**4. Crop at row level?**
Does a row hold a current crop reference (`current_crop_id → crops`)? Or is the
crop always recorded at the time of the work event?
- Storing crop on the row enables "show all Tomato rows" in the Greenhouse View.
- Crop changes seasonally, making it mutable state on master data.
Recommendation: leave crop off rows in v1. Derive from the work event's crop
context. Revisit when building the Greenhouse View.

**5. Scan code format?**
The physical QR/RFID content can take several forms:
- Path-based: "HQ-GH01-PH1-H1-R001" — readable, long
- Short random: "X4K9" — compact, meaningless
- Sequential integer: 10001 — very compact, easy to print
- UUID: fully opaque, no collision risk
Format should be decided before printing physical labels. The DB stores whatever
string is chosen.

**6. Row direction — stored or derived?**
For the Greenhouse View map, each row's direction (which way it runs) could be:
- Stored explicitly per row (the current design) — handles irregular layouts.
- Derived from the greenhouse's `orientation_deg` — simpler, assumes all rows
  in a greenhouse are parallel.
In the common case (all rows parallel), derivation is correct and requires no
extra data entry. Storing it explicitly is more general.

**7. Phase semantics — physical or temporal?**
Is a "phase" a fixed physical compartment (a permanently walled zone), or a
crop-rotation stage that changes per season (the same physical space can be
"Phase A — Summer Tomato" in Q2 and "Phase B — Winter Cucumber" in Q4)?
If temporal, work event history must capture which phase definition was active.
The current design treats phases as fixed physical zones. Temporal phases would
require a versioned or time-bounded phase model.

**8. Archive cascade direction?**
When a greenhouse is archived:
- Option A: All phases, houses, and rows are automatically archived (cascade).
- Option B: Each level is archived individually; the parent's archived_at is
  informational only.
Recommendation: Option A, enforced at the API layer (not via DB trigger).
This avoids leaving "orphaned active rows" under an archived greenhouse.

**9. Multi-site employees?**
In v1 can an employee work shifts at more than one site? If yes, the Input domain's
work events need a `site_id` column to avoid ambiguity when rows at two sites share
the same sort_order / code. If employees are strictly one-site, this is a non-issue.

**10. Site configuration scope?**
Should `sites` eventually carry operational configuration — default shift hours,
public holiday calendar, payroll cut-off time — or should those live in a
separate `site_config` table? Keeping sites minimal now avoids premature columns,
but a plan for where config lands is worth agreeing on early.
