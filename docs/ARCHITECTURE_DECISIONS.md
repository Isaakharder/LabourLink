# Architecture Decision Records

This file documents significant architectural decisions made during the
design and development of LabourLink.

Each ADR captures the context at the time the decision was made, the
decision itself, and the consequences — including trade-offs accepted.

---

## ADR-001 — Local-First Docker Architecture

**Date:** 2026-06-29
**Status:** Accepted

### Context

LabourLink is deployed inside a greenhouse. The greenhouse may have
unreliable or no internet connectivity. Operational continuity must
not depend on reaching an external service.

The system must:
- Be runnable on a single local machine or small server
- Be installable and updatable without developer intervention
- Isolate its services (database, API, frontend) cleanly

### Decision

All services are packaged as Docker containers and orchestrated with
Docker Compose. The three services are:

- **postgres** — the single source of truth for all data
- **api** — the Express/Node.js API; the only process that writes to the database
- **web** — the React frontend served locally

No external network calls are made at runtime. All data stays on-site.

### Consequences

**Accepted trade-offs:**
- A local machine running Docker is required; this is a managed, known constraint
- Remote access (e.g. from an office) requires VPN or local network access — acceptable

**Benefits:**
- Zero dependency on external services or internet connectivity
- Data sovereignty: all data remains in the greenhouse
- Simple deployment: `docker-compose up` on the local machine
- Consistent environment between development and production

---

## ADR-002 — Event-Driven Architecture

**Date:** 2026-06-29
**Status:** Accepted

### Context

The core operations of LabourLink are things that *happen*:

- An employee starts working at 07:00
- A break begins at 10:15 and ends at 10:30
- A carrier of yield is registered at location B-12

These are facts about the real world at a specific point in time.
Modelling them as mutable rows ("current state") would lose the temporal
dimension and make it impossible to reconstruct what happened when.

### Decision

State changes are modelled as immutable events appended to the record,
not as updates to a single mutable row.

For example, a labour registration is not a row that is "updated when
the employee finishes" — it is a pair of events: `clock_in` and
`clock_out`, each recorded at the time they occur.

The current state of a registration is *derived* from the sequence of
events, not stored as a single mutable value.

### Consequences

**Accepted trade-offs:**
- Querying "current state" requires aggregating events, which is slightly more
  complex than reading a single column — addressed with views or query helpers
- Developers must think in terms of events, not CRUD

**Benefits:**
- Complete, auditable history with no extra effort
- No data is ever destroyed by an update
- Replaying events allows reconstructing any past state
- Natural fit for the "history is never overwritten" principle (ADR-003)

---

## ADR-003 — History Is Never Overwritten

**Date:** 2026-06-29
**Status:** Accepted

### Context

Labour data drives payroll. If a registration is changed after the fact
and the original is lost, disputes cannot be resolved and audits cannot
be completed. Legal and operational requirements demand a full audit trail.

Additionally, master data changes over time: an employee's contract rate
changes, an activity is renamed, a location is restructured. These changes
must not silently affect historical records.

### Decision

No record that has affected any operational output is ever hard-deleted
or overwritten. Specifically:

- **Deletions** are soft: records gain an `archived_at` timestamp and
  are excluded from active queries, but remain in the database
- **Updates to master data** create a new version of the record; the
  previous version is retained with its effective date range
- **Corrections to event data** are recorded as new corrective events,
  not edits to the original

The only exception is data that has never affected any output and was
entered in error — this may be physically deleted during a defined
correction window, with a logged reason.

### Consequences

**Accepted trade-offs:**
- Database grows over time and is never pruned — managed by the backup
  strategy and PostgreSQL's efficient storage
- Queries for "active" records must always filter on `archived_at IS NULL`
  — addressed by consistent query patterns and views

**Benefits:**
- Full audit trail by default; no extra instrumentation required
- Historical payroll records remain accurate even if master data changes
- Disputes can always be resolved by inspecting the record at the time
  of the event

---

## ADR-004 — Master Data vs Event Data

**Date:** 2026-06-29
**Status:** Accepted

### Context

Two fundamentally different types of data exist in LabourLink, and they
have different characteristics, access patterns, and lifecycle rules.

Conflating them leads to schema confusion, incorrect query patterns, and
components that do too much.

### Decision

The system explicitly separates two data categories:

**Master data** — the nouns of the system. Defined once, referenced many
times, changes infrequently. Subject to versioning and soft-delete.

| Entity | Examples |
|---|---|
| Employees | Name, date of birth, BSN |
| Contract templates | Pay rates, hour definitions |
| Activities | Harvesting, planting, packing |
| Crops / Varieties | Tomato → Cherry, Beef |
| Locations / Groups | Greenhouse A → Row 1–24 |
| Carriers | Trolley, bin, crate |
| Teams | Named groups of employees |

**Event data** — the verbs of the system. Created when something happens,
never modified after creation, append-only.

| Entity | Examples |
|---|---|
| Labour registrations | Employee X worked activity Y at location Z |
| Break registrations | Break started / ended |
| Yield registrations | N carriers registered at location Z |
| Employment history | Contract assigned / changed on date D |
| Corrections | Original event E corrected by event F |

### Consequences

**Accepted trade-offs:**
- Modules must be explicitly categorised as master-data or event-data;
  there is no catch-all "data" module

**Benefits:**
- Clear module boundaries in both the API and the frontend navigation
- Master data uses CRUD-like patterns; event data uses append-only patterns
- Payroll output is always derived from event data joined to master data
  *at the time of the event*, not at query time — preserving historical accuracy
- The distinction maps directly to the sidebar: Basic Data = master data,
  Input = event data, Reports = derived views over both

---

## DEV-001 — No UTF-8 BOM in Generated Files

**Date:** 2026-06-29
**Status:** Accepted

### Context

During initial project setup, several files were written using PowerShell 5.1's
`Set-Content -Encoding utf8`. That encoding silently prepends a UTF-8 BOM
(`0xEF 0xBB 0xBF`) to every file. When Vite's JSON parser (via cosmiconfig)
reads `package.json`, the leading BOM character causes an immediate parse
failure and the dev server will not start.

### Decision

All files in this repository must be UTF-8 **without** BOM.

- The `Write` tool (Claude Code built-in) does not add a BOM — prefer it.
- When PowerShell must write a file, use:
  ```powershell
  [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
  ```
  `$false` suppresses the BOM. `Set-Content -Encoding utf8` must not be used.
- `.gitattributes` enforces `eol=lf` across all text files to prevent
  a second class of Windows line-ending issues.

### Consequences

- Any tooling that generates or patches files on Windows must be checked
  for BOM output before it is introduced into the workflow.
- The `[System.Text.UTF8Encoding]::new($false)` pattern is the standard
  for any PowerShell file writes in this project.
