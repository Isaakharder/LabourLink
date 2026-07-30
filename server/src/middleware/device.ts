import { NextFunction, Request, Response } from "express";
import { pool } from "../db";

export interface AuthedDevice {
  id: string;
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
}

declare global {
  namespace Express {
    interface Request {
      device?: AuthedDevice;
    }
  }
}

// Mobile requests carry no session cookie — the device_identifier itself
// (a persistent random value generated on the phone, never a secret typed
// by a human) is the credential. It's checked against the DB on every
// request rather than cached/trusted, so deactivating a device or ending
// its assignment takes effect immediately: no employee ID the client sends
// is ever trusted, it's always looked up fresh from the active assignment.
export async function requireDevice(req: Request, res: Response, next: NextFunction) {
  const deviceIdentifier = req.header("X-Device-Id");
  if (!deviceIdentifier) {
    return res.status(401).json({ error: "Device not identified" });
  }

  const { rows } = await pool.query(
    `select d.id as device_id, e.id as employee_id,
            e.first_name, e.last_name
     from devices d
     join device_assignments da on da.device_id = d.id and da.unassigned_at is null
     join employees e on e.id = da.employee_id
     where d.device_identifier = $1 and d.is_active = true and e.is_active = true`,
    [deviceIdentifier]
  );

  const row = rows[0];
  if (!row) {
    return res.status(401).json({ error: "Device not authorized" });
  }

  pool
    .query("update devices set last_seen = now() where id = $1", [row.device_id])
    .catch((err) => console.error("Failed to update device last_seen:", err.message));

  req.device = {
    id: row.device_id,
    employeeId: row.employee_id,
    employeeFirstName: row.first_name,
    employeeLastName: row.last_name,
  };
  next();
}
