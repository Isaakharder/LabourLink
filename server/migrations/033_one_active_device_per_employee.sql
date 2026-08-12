-- An employee may only hold one active (unassigned_at is null) device at a
-- time. Previously only enforced per-device (idx_device_assignments_active_
-- per_device, 001_initial_schema.sql) — nothing stopped an employee from
-- accumulating multiple simultaneously-active assignments across different
-- devices, which the GET /api/employees list query's unaggregated join then
-- fanned out into one duplicate row per extra device, e.g. the same
-- employee UUID appearing twice in the Employees page.
--
-- Close every pre-existing duplicate before adding the constraint, keeping
-- only the most recently assigned device active per employee (mirrors the
-- "reassigning closes the old one" behavior devices.ts already applies on
-- the device side).
with ranked as (
  select id,
         row_number() over (partition by employee_id order by assigned_at desc) as rn
  from device_assignments
  where unassigned_at is null
)
update device_assignments
set unassigned_at = now()
where id in (select id from ranked where rn > 1);

create unique index idx_device_assignments_active_per_employee
  on device_assignments(employee_id)
  where unassigned_at is null;
