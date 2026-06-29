# LabourLink — Design Principles

## 1. Local-First

LabourLink runs entirely inside the greenhouse network.
No cloud dependency. No internet required during operation.

## 2. Event-Driven Architecture

State changes are communicated through events.
The system reacts to what happens rather than polling.

## 3. Nothing Important Is Deleted

Records are never hard-deleted.
Deletion is modelled as a state transition (e.g. `archived`, `inactive`).

## 4. History Is Never Overwritten

When data changes, the previous state is preserved.
Audit trails are first-class, not an afterthought.

## 5. Everything Should Be Configurable

Business rules, pay rates, activity types, locations — all should be
defined in configuration, not hardcoded.

## 6. Consistent Page Layout

Every page follows the same structural pattern:
- Page header with title and primary action
- Filter/search bar where applicable
- Data table or form

## 7. Long-Term Scalability Over Speed

The architecture is chosen for correctness and maintainability.
New features are built properly or not built yet.
