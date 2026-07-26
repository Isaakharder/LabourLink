import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`
    select
      (select count(*) from employees where is_active = true) as total_employees,
      (select count(*) from devices where is_active = true) as total_devices,
      (select count(*) from devices d where d.is_active = true
         and exists (
           select 1 from device_assignments da
           where da.device_id = d.id and da.unassigned_at is null
         )) as assigned_devices,
      (select count(*) from devices d where d.is_active = true
         and not exists (
           select 1 from device_assignments da
           where da.device_id = d.id and da.unassigned_at is null
         )) as unassigned_devices,
      (select count(*) from pairing_requests where status = 'pending' and expires_at > now()) as devices_waiting_for_setup
  `);

  const row = rows[0];
  res.json({
    totalEmployees: Number(row.total_employees),
    totalDevices: Number(row.total_devices),
    assignedDevices: Number(row.assigned_devices),
    unassignedDevices: Number(row.unassigned_devices),
    devicesWaitingForSetup: Number(row.devices_waiting_for_setup),
  });
});

export default router;
