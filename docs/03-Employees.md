# Employee Domain

## Overview

An employee is a person employed at one or more greenhouse sites under a
single company account. The employee domain covers identity, employment
status, and the relationship between employees, devices, and sites.

Activity registration (what an employee does during a shift) is part of
the Input domain, not the Employee domain. The boundary is intentional:
employment defines *who the person is and where they work*; activity
registrations record *what they did and when*.

---

## Domain Decisions

### Employment Records

**1. One active employment record at a time.**
An employee normally has one active employment record at any given moment.
Employment records define the structural relationship between an employee
and the organisation — role, contract, site, team, and supervisor.

**2. Employment defines role, contract, site, team, and supervisor.**
These are stable attributes that change infrequently. They belong to the
employment record, not to individual work sessions.

**3. Daily work changes are activity registrations, not employment changes.**
If an employee harvests in the morning and packs in the afternoon, those
are two activity registrations — not two employment records. Employment
is changed only when the structural relationship changes (new contract,
new site, new supervisor, etc.).

---

### Activity Registrations

**4. One employee can have many activity registrations per day.**
There is no limit on how many activities an employee performs in a day.
Each registration captures a start time, end time, activity type, and
location.

**5. Only one activity registration can be active at a time.**
An employee cannot be actively registered to two activities simultaneously.
"Active" means started but not yet ended.

**6. Starting a new activity automatically ends the previous active activity.**
When a new activity registration is created for an employee who already
has an active registration, the system closes the previous registration
at the start time of the new one. No manual close is required.

---

### Devices

**7. LabourLink will not use NFC cards in v1.**
NFC-based employee identification is explicitly out of scope for the
initial version. Employee identity is established through device
assignment or PIN-based selection.

**8. Phones are LabourLink devices.**
The primary input device is an Android phone. Each phone runs the
LabourLink mobile app. Devices are tracked in the system and linked
to employees or configured as shared.

**9. A device can be assigned to one employee or configured as a shared device.**
- **Assigned device:** the device is permanently linked to one employee.
  The employee does not need to select themselves when starting work.
- **Shared device:** the device is not permanently linked to any employee.
  Any employee can use it.

**10. Shared devices show an employee selection list.**
When a shared device is used to start a registration, the app presents
a list of employees. The employee selects themselves before proceeding.

**11. Changing the assigned employee on a non-shared device requires a manager or admin PIN.**
A device assignment cannot be changed by the employee using the device.
This prevents employees from registering under someone else's identity.
The PIN is entered by a manager or administrator at the device.

---

### Multi-Site Support

**12. LabourLink supports multiple greenhouse sites under one company.**
A single LabourLink installation manages all sites for one company.
Sites are first-class entities in the data model, not an afterthought.

**13. One employee may work at multiple sites.**
An employee's employment record is linked to a primary site, but the
employee may also perform registrations at other sites. Cross-site
activity is supported from the start.

**14. Sites must be part of the data model from the start.**
Every entity that belongs to a site — locations, teams, devices,
employment records — carries a site reference. Retrofitting multi-site
support later is significantly more disruptive than including it in the
initial schema.

---

### Audit and Device History

**15. Device assignment and employee login history must be tracked.**
The following events are recorded and never deleted:
- When a device was assigned to an employee
- When a device assignment was changed (who changed it, when, and why)
- Which employee used a shared device and when (login history)

This provides an auditable link between a device, an employee, and any
registrations created through that device.

---

## Data Model (outline)

The full schema is designed in the Chapter 3 schema document.
Key entities:

| Entity | Category | Description |
|---|---|---|
| `employees` | Master | Identity: name, date of birth, contact details |
| `employment_records` | Master | Role, contract, site, team, supervisor, effective dates |
| `sites` | Master | Physical greenhouse locations under the company |
| `devices` | Master | Android phones registered to the system |
| `device_assignments` | History | Which employee a device is assigned to, with timestamps |
| `device_login_history` | Event | Employee selections on shared devices |

---

## Employee Lifecycle

```
Created → Active employment → Employment changed → ... → Archived
```

An employee is never deleted. When an employee leaves, their record is
archived (`archived_at` is set). All historical registrations remain
intact and are excluded only from active-employee queries.

An employment record ends when a new one begins (start date of new record
= end date of previous). The old record is retained.

---

## Relationship to Other Domains

| Domain | Relationship |
|---|---|
| Input | Activity registrations reference `employees` and `employment_records` |
| Contracts | Contract templates are linked through `employment_records` |
| Locations | Registrations link to locations; locations link to sites |
| Devices | Devices reference employees via assignments; both are master data |
| Reports | Payroll output joins registrations to employment records at event time |
