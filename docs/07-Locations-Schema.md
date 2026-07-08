# Location Domain — Schema Reference

**Status:** Migration 005 written and verified
**Chapter:** 7

---

## Tables

### `sites`

**Pre-existing — created in migration 002 (Employee Domain).**
Migration 005 adds the `timezone` column only (`ALTER TABLE sites ADD COLUMN timezone`).

`sites` belongs to a `companies` parent (HR domain) and `code` is unique per company,
not globally. The development sites `GHA` and `GHB` (seeded in migration 003) inherit
`timezone = 'Europe/Amsterdam'` from the column default.

Full column list after migration 005:

| Column | Type | Source |
|---|---|---|
| `id` | SERIAL PK | migration 002 |
| `company_id` | INTEGER FK→companies NOT NULL | migration 002 |
| `name` | TEXT NOT NULL | migration 002 |
| `code` | TEXT NOT NULL — unique within company | migration 002 |
| `address` | TEXT | migration 002 |
| `archived_at` | TIMESTAMPTZ | migration 002 |
| `created_at` | TIMESTAMPTZ NOT NULL | migration 002 |
| `updated_at` | TIMESTAMPTZ NOT NULL | migration 002 |
| `timezone` | TEXT NOT NULL DEFAULT 'Europe/Amsterdam' | **migration 005** — governs shift/payroll date boundaries |

---

### `greenhouses`

A physical greenhouse building within a site. Carries map dimensions for the
future Greenhouse View feature.

```sql
CREATE TABLE greenhouses (
  id               SERIAL PRIMARY KEY,
  site_id          INTEGER     NOT NULL REFERENCES sites(id),
  code             TEXT        NOT NULL,
  name             TEXT        NOT NULL,
  display_name     TEXT,
  map_width_m      NUMERIC(8,2),
  map_length_m     NUMERIC(8,2),
  orientation_deg  SMALLINT    DEFAULT 0
                   CHECK (orientation_deg BETWEEN 0 AND 359),
  sort_order       INTEGER     NOT NULL DEFAULT 0,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT greenhouses_code_key    UNIQUE (site_id, code),
  CONSTRAINT greenhouses_code_format CHECK  (code ~ '^[A-Z0-9]{1,8}$')
);
```

| Column | Notes |
|---|---|
| `site_id` | Parent site. Not nullable. |
| `code` | Uppercase, unique within site. E.g. `GH01`. |
| `display_name` | Optional translated/friendly name. |
| `map_width_m` | Physical width in metres. Nullable until Greenhouse View is built. |
| `map_length_m` | Physical length in metres. Nullable. |
| `orientation_deg` | Compass bearing of the greenhouse long axis. 0 = North, 90 = East. |

---

### `phases`

A climate zone, compartment, or section within a greenhouse. In Dutch greenhouse
terminology: *afdeling*. In operations that do not use phases, a single nominal
"Phase 1" acts as a transparent intermediary.

```sql
CREATE TABLE phases (
  id             SERIAL PRIMARY KEY,
  greenhouse_id  INTEGER     NOT NULL REFERENCES greenhouses(id),
  code           TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  display_name   TEXT,
  sort_order     INTEGER     NOT NULL DEFAULT 0,
  archived_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT phases_code_key    UNIQUE (greenhouse_id, code),
  CONSTRAINT phases_code_format CHECK  (code ~ '^[A-Z0-9]{1,8}$')
);
```

| Column | Notes |
|---|---|
| `greenhouse_id` | Parent greenhouse. Not nullable. |
| `code` | Uppercase, unique within greenhouse. E.g. `PH1`, `A`. |

---

### `houses`

A bay or structural span within a phase. In Dutch: *kap* (the unit between two
roof ridges). Contains the individual rows.

```sql
CREATE TABLE houses (
  id           SERIAL PRIMARY KEY,
  phase_id     INTEGER     NOT NULL REFERENCES phases(id),
  code         TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  display_name TEXT,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT houses_code_key    UNIQUE (phase_id, code),
  CONSTRAINT houses_code_format CHECK  (code ~ '^[A-Z0-9]{1,8}$')
);
```

| Column | Notes |
|---|---|
| `phase_id` | Parent phase. Not nullable. |
| `code` | Uppercase, unique within phase. E.g. `H1`, `BAY01`. |

---

### `rows`

The leaf node of the hierarchy. The primary scan target and the unit tracked by
the Greenhouse View. Must never be hard-deleted — work events reference `rows.id`
permanently.

```sql
CREATE TABLE rows (
  id          SERIAL PRIMARY KEY,
  house_id    INTEGER     NOT NULL REFERENCES houses(id),
  code        TEXT        NOT NULL,
  name        TEXT,
  map_x_m     NUMERIC(8,3),
  map_y_m     NUMERIC(8,3),
  length_m    NUMERIC(6,2),
  direction   TEXT        CHECK (direction IN ('north','south','east','west')),
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rows_code_key    UNIQUE (house_id, code),
  CONSTRAINT rows_code_format CHECK  (code ~ '^[A-Z0-9]{1,8}$')
);
```

| Column | Notes |
|---|---|
| `house_id` | Parent house. Not nullable. |
| `code` | Display code, unique within house. E.g. `R001`. |
| `name` | Optional friendly name. E.g. `Row 1`. |
| `map_x_m` | Distance from greenhouse origin along the X axis (metres). Nullable. |
| `map_y_m` | Distance from greenhouse origin along the Y axis (metres). Nullable. |
| `length_m` | Physical row length in metres. Nullable. |
| `direction` | Cardinal direction the row runs. Nullable; defaults derived from greenhouse orientation if not set. |

---

### `row_scan_codes`

A row can have multiple physical scan codes — a QR label at each end plus an RFID
tag, for example. This child table holds all of them. The mobile scanner resolves
any scan code to its parent row via a globally unique index on `scan_code`.

```sql
CREATE TABLE row_scan_codes (
  id          SERIAL PRIMARY KEY,
  row_id      INTEGER     NOT NULL REFERENCES rows(id),
  scan_code   TEXT        NOT NULL,
  scan_type   TEXT        NOT NULL CHECK (scan_type IN ('qr','rfid','barcode','manual')),
  label       TEXT,
  is_primary  BOOLEAN     NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT row_scan_codes_scan_code_key UNIQUE (scan_code)
);
```

| Column | Notes |
|---|---|
| `row_id` | Parent row. Not nullable. |
| `scan_code` | The actual QR/RFID/barcode content. Globally unique across all rows. |
| `scan_type` | Always required. Declares how this code is read: `qr`, `rfid`, `barcode`, `manual`. |
| `label` | Optional human description. E.g. `QR north end`, `RFID chip`. |
| `is_primary` | TRUE for the canonical code shown in the UI and used for label printing. At most one active primary per row (enforced by partial unique index). |
| `archived_at` | NULL = active. Individual codes can be retired without removing the row. |

---

## Relationships

```
sites  ──(1:N)──  greenhouses  ──(1:N)──  phases  ──(1:N)──  houses  ──(1:N)──  rows  ──(1:N)──  row_scan_codes
```

Future reference from Input domain:
```
work_events.location_row_id  ──(N:1)──  rows.id   (nullable; set when activity requires_location)
```

Archived rows remain permanently reachable via FK. Work events do not break when
the row (or any ancestor) is archived. Individual scan codes can be retired
(`archived_at`) without removing the row or any other codes.

---

## Indexes

```sql
-- updated_at triggers (same pattern as Activities)
CREATE TRIGGER sites_updated_at
  BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER greenhouses_updated_at
  BEFORE UPDATE ON greenhouses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER phases_updated_at
  BEFORE UPDATE ON phases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER houses_updated_at
  BEFORE UPDATE ON houses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER rows_updated_at
  BEFORE UPDATE ON rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER row_scan_codes_updated_at
  BEFORE UPDATE ON row_scan_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Greenhouse list per site (active only, ordered)
CREATE INDEX idx_greenhouses_site
  ON greenhouses (site_id, sort_order)
  WHERE archived_at IS NULL;

-- Phase list per greenhouse
CREATE INDEX idx_phases_greenhouse
  ON phases (greenhouse_id, sort_order)
  WHERE archived_at IS NULL;

-- House list per phase
CREATE INDEX idx_houses_phase
  ON houses (phase_id, sort_order)
  WHERE archived_at IS NULL;

-- Row list per house
CREATE INDEX idx_rows_house
  ON rows (house_id, sort_order)
  WHERE archived_at IS NULL;

-- Greenhouse View: active rows with map coordinates
CREATE INDEX idx_rows_map
  ON rows (map_x_m, map_y_m)
  WHERE archived_at IS NULL AND map_x_m IS NOT NULL;

-- Scan code lookup is O(1) via the UNIQUE constraint on scan_code (implicit index).
-- Scan codes are never reused — the constraint covers archived codes too,
-- so an old label cannot accidentally point to a new row.

-- At most one active primary per row
CREATE UNIQUE INDEX idx_row_scan_codes_primary
  ON row_scan_codes (row_id)
  WHERE is_primary = TRUE AND archived_at IS NULL;

-- Scan codes per row (for the detail panel listing all codes)
CREATE INDEX idx_row_scan_codes_row
  ON row_scan_codes (row_id)
  WHERE archived_at IS NULL;
```

---

## Constraints Summary

| Constraint | Table | Rule |
|---|---|---|
| `sites_company_code_key` | sites | `code` unique within company (from migration 002) |
| `greenhouses_site_code_key` | greenhouses | `code` unique within site |
| `greenhouses_code_format` | greenhouses | `^[A-Z0-9]{1,8}$` |
| `orientation_deg` range | greenhouses | 0–359 |
| `phases_code_key` | phases | `code` unique within greenhouse |
| `phases_code_format` | phases | `^[A-Z0-9]{1,8}$` |
| `houses_code_key` | houses | `code` unique within phase |
| `houses_code_format` | houses | `^[A-Z0-9]{1,8}$` |
| `rows_code_key` | rows | `code` unique within house |
| `rows_code_format` | rows | `^[A-Z0-9]{1,8}$` |
| `row_scan_codes_scan_code_key` | row_scan_codes | `scan_code` globally unique — forever, including archived |
| `scan_type` CHECK | row_scan_codes | `qr` / `rfid` / `barcode` / `manual` |
| `idx_row_scan_codes_primary` | row_scan_codes | at most one active primary per row (partial) |
| Soft-delete only | all | No hard deletes on any location table |

---

## Sample / Seed Data

The migration seeds only the minimum required to start development.
Actual location data (greenhouses, phases, houses, rows) is customer-specific
and entered by managers through the UI.

### Migration 005 seed

None. Location hierarchy data is customer-entered through the UI.

The existing sites from migration 003 (`GHA` — Greenhouse A, `GHB` — Greenhouse B)
are already present and inherit `timezone = 'Europe/Amsterdam'` from the new column
default. No sites are added in migration 005.

### Development example (not in seed — shown for reference)

```
GHA — Greenhouse A  (existing site from migration 003)
  GH01 — Greenhouse 1  (120m × 15m, orientation 0°)
    PH1 — Phase 1  (sort 1)
      H1 — House 1  (sort 1)
        R001  scan: GHA-GH01-PH1-H1-R001  map: x=0.0 y=0.50  length=120m  dir=east
        R002  scan: GHA-GH01-PH1-H1-R002  map: x=0.0 y=1.50  length=120m  dir=east
        ...   (sort_order determines row position on map)
      H2 — House 2  (sort 2)
        R001–R010
    PH2 — Phase 2  (sort 2)
      H1 — House 1
        R001–R010

GHB — Greenhouse B  (existing site from migration 003)
  GH01 — Greenhouse 1  (80m × 12m, orientation 0°)
    PH1 — Phase 1
      H1 — House 1
        R001–R006
```

Scan code format used here is illustrative.
The actual format is an open question — see `07-Locations.md`.

---

## Full Hierarchy Query (reference)

Fetches the complete path from a scan code to a site, as needed by the
mobile scanning flow and Greenhouse View.

```sql
SELECT
  r.id            AS row_id,
  r.code          AS row_code,
  r.name          AS row_name,
  rsc.scan_code   AS matched_scan_code,
  rsc.scan_type   AS matched_scan_type,
  h.code          AS house_code,
  h.name          AS house_name,
  p.code          AS phase_code,
  p.name          AS phase_name,
  g.code          AS greenhouse_code,
  g.name          AS greenhouse_name,
  s.code          AS site_code,
  s.name          AS site_name,
  s.timezone      AS site_timezone
FROM row_scan_codes rsc                        -- O(1) via idx_row_scan_codes_active
JOIN rows           r  ON r.id  = rsc.row_id
JOIN houses         h  ON h.id  = r.house_id
JOIN phases         p  ON p.id  = h.phase_id
JOIN greenhouses    g  ON g.id  = p.greenhouse_id
JOIN sites          s  ON s.id  = g.site_id
WHERE rsc.scan_code    = $1
  AND rsc.archived_at IS NULL;
```

---

## Design Decisions Reference

| # | Decision |
|---|---|
| 1 | Five-level hierarchy: Site → Greenhouse → Phase → House → Row |
| 2 | Codes unique within parent; globally unique only for `scan_code` |
| 3 | Code format `^[A-Z0-9]{1,8}$` at every level, DB CHECK + API |
| 4 | Scan codes in `row_scan_codes` child table — a row can have multiple (QR + RFID + barcode) |
| 5 | `scan_type` NOT NULL on `row_scan_codes` — always required; no orphaned codes without a declared type |
| 6 | `is_primary` marks the canonical code per row; partial unique index prevents duplicate primaries |
| 6a | Map coordinates (map_x_m, map_y_m, length_m, direction) nullable until Greenhouse View is built |
| 7 | No hard deletes at any level; archived_at soft-delete only |
| 8 | Archive cascade enforced at API layer, not DB trigger |
| 9 | Single site in v1; schema supports multiple from day one |
| 10 | Activities global; locations per-site |
