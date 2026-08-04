import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { fingerprintDeviceIdentifier } from "../middleware/device";

const router = Router();
router.use(requireAuth, requireRole("Administrator", "Manager"));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get(
  "/pairing-requests",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `select id, pairing_code, device_identifier, created_at, expires_at
       from pairing_requests
       where status = 'pending' and expires_at > now()
       order by created_at asc`
    );
    res.json({ requests: rows });
  })
);

router.post(
  "/pairing-requests/:id/approve",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { deviceName, employeeId } = req.body as {
      deviceName?: string;
      employeeId?: string;
    };
    if (!deviceName || !employeeId || !UUID_RE.test(employeeId) || !UUID_RE.test(id)) {
      return res.status(400).json({ error: "deviceName and a valid employeeId are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const reqRow = await client.query(
        `select device_identifier from pairing_requests
         where id = $1 and status = 'pending' and expires_at > now()
         for update`,
        [id]
      );
      if (!reqRow.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Pairing request not found or expired" });
      }
      const deviceIdentifier = reqRow.rows[0].device_identifier;

      // employeeId is client-supplied — confirm it's a real, active employee
      // before assigning a device to it, rather than letting a bad id surface
      // as a raw foreign-key-violation 500 further down.
      const employeeRow = await client.query(
        "select id from employees where id = $1 and is_active = true",
        [employeeId]
      );
      if (!employeeRow.rows[0]) {
        await client.query("rollback");
        return res.status(400).json({ error: "employeeId does not match an active employee" });
      }

      const deviceRow = await client.query(
        `insert into devices (device_identifier, device_name, is_active, date_paired, last_seen)
         values ($1, $2, true, now(), now())
         on conflict (device_identifier)
         do update set device_name = excluded.device_name, is_active = true, date_paired = now()
         returning id`,
        [deviceIdentifier, deviceName]
      );
      const deviceId = deviceRow.rows[0].id;

      // Re-pairing/reassigning a known device: close whatever active
      // assignment it has before opening a new one, so the partial unique
      // index on device_assignments (one active row per device) never trips.
      const closed = await client.query(
        `update device_assignments set unassigned_at = now()
         where device_id = $1 and unassigned_at is null
         returning employee_id`,
        [deviceId]
      );
      await client.query(
        `insert into device_assignments (device_id, employee_id) values ($1, $2)`,
        [deviceId, employeeId]
      );

      console.log(
        `[device-admin] device=${fingerprintDeviceIdentifier(deviceIdentifier)} ` +
          (closed.rows[0]
            ? `reassigned from employee=${closed.rows[0].employee_id} to employee=${employeeId}`
            : `paired to employee=${employeeId}`) +
          ` by=${req.employee!.id}`
      );

      await client.query(
        `update pairing_requests
         set status = 'approved', approved_by_employee_id = $1, approved_at = now(), resulting_device_id = $2
         where id = $3`,
        [req.employee!.id, deviceId, id]
      );

      await client.query("commit");
      res.json({ deviceId });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  })
);

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`
      select d.id, d.device_name, d.is_active, d.last_seen, d.date_paired,
             e.id as employee_id, e.first_name, e.last_name
      from devices d
      left join device_assignments da on da.device_id = d.id and da.unassigned_at is null
      left join employees e on e.id = da.employee_id
      order by d.date_paired desc nulls last
    `);
    res.json({ devices: rows });
  })
);

router.post(
  "/:id/deactivate",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid device id" });
    }
    const result = await pool.query(
      "update devices set is_active = false where id = $1 returning device_identifier",
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Device not found" });
    }
    console.log(
      `[device-admin] device=${fingerprintDeviceIdentifier(result.rows[0].device_identifier)} ` +
        `deactivated by=${req.employee!.id}`
    );
    res.status(204).send();
  })
);

export default router;
