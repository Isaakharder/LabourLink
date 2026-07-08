# Future Feature — Greenhouse View

**Status:** Designed, not built
**Depends on:** Locations, Activities, Work Events, Mobile Scanning, Input Dashboard

---

## What It Is

A live map of the greenhouse that shows crop-work progress at row level,
updated in real time from the event log. Managers and supervisors can see —
without asking anyone — which rows are being worked, which are done, which
are paused, and which need attention.

---

## Entry Point

A dedicated button in the top header bar, visible at all times.
Clicking it opens the Greenhouse View as a full-page overlay or a
dedicated route (`/greenhouse-view`).

This is a read-only monitoring screen, not an input screen.

---

## Row States

Each row on the map shows exactly one color at any given moment.
The color is derived from the event log — it is never manually set.

| State | Color | Meaning |
|---|---|---|
| Not started | Gray (neutral) | No work event recorded for this row today |
| Active | Blue | An employee is currently working this row |
| Completed | Green | Row work is finished; employee has moved to a new row or clocked out cleanly |
| Paused | Yellow | Employee was on this row but is now on break or lunch |
| Flagged | Red | Row was skipped, has a reported issue, or requires supervisor attention |

---

## State Derivation Rule

The state of a row is **always derived from the event log** by inspecting the
most recent work event that references that row, for the current shift/day.

```
row state = f(most recent event referencing this row within the active shift)
```

There is no `row_status` column that is manually updated.
If the event log says the row is active, it is blue. No exceptions.

This is the only design-safe approach: it means the map is always consistent
with the registration data, and no synchronisation logic is needed.

---

## Workflow and State Transitions

```
[Row created in master data]
        │
        ▼
    NEUTRAL (gray)
        │
        │  employee selects an activity on phone
        │  employee scans or enters a row number
        ▼
    ACTIVE (blue)  ◄────────────────────┐
        │                               │
        │  employee scans a new row     │  employee resumes after break
        ▼                               │
  COMPLETED (green)               PAUSED (yellow)
        │                               │
        │  supervisor flags it          │  employee clocks back in
        ▼                               │
   FLAGGED (red)  ◄────────────────────┘
        │
        │  supervisor clears the flag
        ▼
  COMPLETED (green)
```

**Scan-to-advance rule:**
When an employee scans a new row while already on an active row, the previous
row automatically transitions to COMPLETED. The new row becomes ACTIVE.
This is a single atomic operation in the event log — no explicit "close row"
step is required from the employee.

**Break rule:**
When an employee goes on break or lunch while assigned to a row, that row
transitions to PAUSED. When the employee resumes work, the row returns to
ACTIVE. The break duration is recorded in the event log, not on the row.

**Clock-out with open row:**
If an employee clocks out while a row is still ACTIVE (no closing scan),
the row remains highlighted and may trigger a supervisor review notification.
The exact outcome (auto-complete vs. hold for review) is a configuration
decision — see Open Questions.

**Flagging:**
A supervisor can manually flag any row to RED at any time via the dashboard.
This is recorded as a corrective event (`row_flagged`), not a direct state
edit. The flag can be cleared by recording a `flag_cleared` event.

---

## Data Requirements

All of the following must exist before this feature can be built:

| Requirement | Source |
|---|---|
| Row/location master data | Locations domain (to be designed) |
| Activity master data | Chapter 6 — Activity Domain |
| Work event log | Input domain — labour registrations |
| Employee-to-row linkage | Work events include `location_id` |
| Break/lunch events | Input domain — break registrations |
| Clock-in / clock-out events | Input domain — shift events |
| Mobile scanning | Android app — barcode or QR per row |

The Greenhouse View does not need its own tables. It is a read query
over the event log joined to the location master data.

---

## Query Shape (design intent, not final SQL)

```
For each active row in the greenhouse:
  1. Find all work events for today's shift that reference this row
  2. Take the most recent event
  3. Map the event type to a display state:
       row_scan / row_resumed        → ACTIVE
       row_completed / new_row_scan  → COMPLETED
       break_started                 → PAUSED
       row_flagged                   → FLAGGED
       (no events)                   → NEUTRAL
```

A materialized view or an API-side aggregation query is the implementation
mechanism. Real-time updates via polling (every N seconds) or WebSocket push
are both acceptable — decide when building.

---

## Display Layout (intent)

The map renders a top-down grid of the greenhouse. Rows are displayed in
physical order (Row 1 → Row N, left to right or top to bottom depending
on greenhouse orientation). Each row is a colored strip or cell.

Hovering or tapping a row shows a tooltip or side panel with:
- Row identifier
- Current employee name (if active or paused)
- Activity being performed
- Time since state last changed
- Any flag notes

---

## What This Feature Is Not

- Not an input screen — employees do not register work here
- Not an editor — row colors are not manually painted
- Not a crop yield dashboard — yield numbers belong in a separate report
- Not a real-time presence tracker for employees — employees are tracked
  via the Input module; this view shows *rows*, not people

---

## Open Questions

**1. Clock-out with unclosed row — auto-complete or hold?**
If an employee clocks out while a row is still ACTIVE:
- Option A: auto-complete the row (assume they finished) — simpler, hides
  forgotten scans
- Option B: flag the row for supervisor review — more accurate, requires
  action
Recommend Option B as default, configurable per site.

**2. Shift scope vs. day scope**
Does the map show today's state or the current shift's state?
If an employee works a row in the morning shift and another employee
picks it up in the afternoon, does the afternoon employee's scan override
the morning's COMPLETED state?
Recommend: map shows the state within the **current shift definition**.
Shift boundaries are a configuration item in the Work Events domain.

**3. Multi-greenhouse support**
If there are multiple greenhouse sections or buildings, does the view
show one greenhouse at a time (with a selector) or all at once?
Recommend: one section at a time, with a section picker in the header.

**4. Row layout source**
The visual grid must know the physical arrangement of rows.
Options:
- Simple ordered list (rows displayed as a fixed grid)
- Configurable layout (rows have x/y positions in master data)
Recommend: ordered list first, configurable positions later.

**5. Refresh rate**
Polling every 30 seconds is simple and low-cost.
WebSocket push is more responsive but adds infrastructure.
Recommend polling at 15–30 seconds for V1; WebSocket as a later upgrade.

**6. Historical view**
Should supervisors be able to rewind the map to see row states at a
past time? This is a natural extension of the event-sourced model —
all the data is there — but is a significant UX effort.
Recommend: live-only for V1; add time-travel as a future version.
