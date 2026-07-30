import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireDevice } from "../middleware/device";

const router = Router();
router.use(asyncHandler(requireDevice));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && UUID_RE.test(key);
}

interface OpenEntry {
  id: string;
  entry_type: "work" | "break";
  activity_id: string | null;
  started_at: string;
}

async function getOpenEntry(employeeId: string): Promise<OpenEntry | null> {
  const { rows } = await pool.query(
    `select id, entry_type, activity_id, started_at
     from time_entries where employee_id = $1 and ended_at is null`,
    [employeeId]
  );
  return rows[0] ?? null;
}

// Opens a new row and closes whatever else is open for this employee — used
// for both "start work" and "change activity" (closing the prior entry and
// opening the next is the same operation either way). The close step
// excludes rows already carrying this idempotency_key — the only row that
// could ever match is one a concurrent replay of this exact request already
// created, so excluding it is what stops a duplicate tap from closing the
// very row it was supposed to return. Closing must run before inserting:
// insert-first would briefly have two open rows for the same employee
// (the old one, still open, plus the new one), which the partial unique
// index on "one open row per employee" rejects outright.
async function openEntry(
  employeeId: string,
  deviceId: string,
  entryType: "work" | "break",
  activityId: string | null,
  idempotencyKey: string
): Promise<OpenEntry> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    await client.query(
      `update time_entries set ended_at = now()
       where employee_id = $1 and ended_at is null and idempotency_key <> $2`,
      [employeeId, idempotencyKey]
    );

    const insert = await client.query(
      `insert into time_entries (employee_id, device_id, entry_type, activity_id, idempotency_key)
       values ($1, $2, $3, $4, $5)
       on conflict (idempotency_key) do nothing
       returning id, entry_type, activity_id, started_at`,
      [employeeId, deviceId, entryType, activityId, idempotencyKey]
    );

    let row = insert.rows[0];
    if (!row) {
      const existing = await client.query(
        `select id, entry_type, activity_id, started_at from time_entries where idempotency_key = $1`,
        [idempotencyKey]
      );
      row = existing.rows[0];
    }

    await client.query("commit");
    return row;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if ((err as { code?: string }).code === "23505") {
      // Lost a race against a concurrent transition for the same employee
      // (e.g. a double-tap that fired two requests). Report whichever
      // transition actually won instead of erroring out.
      const current = await getOpenEntry(employeeId);
      if (current) return current;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function serializeStatus(employeeId: string, employeeFirstName: string, employeeLastName: string) {
  const open = await getOpenEntry(employeeId);
  let activity: { id: string; name: string } | null = null;
  if (open?.activity_id) {
    const { rows } = await pool.query("select id, name from activities where id = $1", [
      open.activity_id,
    ]);
    activity = rows[0] ?? null;
  }
  return {
    employee: { id: employeeId, firstName: employeeFirstName, lastName: employeeLastName },
    status: open ? open.entry_type : "idle",
    activity,
    since: open?.started_at ?? null,
  };
}

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
  })
);

router.get(
  "/activities",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      "select id, name from activities where is_active = true order by sort_order"
    );
    res.json({ activities: rows });
  })
);

router.post(
  "/time-entries/work",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { activityId, idempotencyKey } = req.body as {
      activityId?: string;
      idempotencyKey?: string;
    };
    if (!activityId || !UUID_RE.test(activityId) || !isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ error: "activityId and a valid idempotencyKey are required" });
    }
    // activityId is client-supplied — confirm it's a real, active activity
    // before opening an entry against it, rather than letting a bad id
    // surface as a raw foreign-key-violation 500.
    const activityCheck = await pool.query(
      "select id from activities where id = $1 and is_active = true",
      [activityId]
    );
    if (!activityCheck.rows[0]) {
      return res.status(400).json({ error: "activityId does not match an active activity" });
    }
    await openEntry(d.employeeId, d.id, "work", activityId, idempotencyKey);
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
  })
);

router.post(
  "/time-entries/break/start",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { idempotencyKey } = req.body as { idempotencyKey?: string };
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ error: "a valid idempotencyKey is required" });
    }
    await openEntry(d.employeeId, d.id, "break", null, idempotencyKey);
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
  })
);

router.post(
  "/time-entries/break/end",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    const { idempotencyKey } = req.body as { idempotencyKey?: string };
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ error: "a valid idempotencyKey is required" });
    }

    // Resume whatever activity was active before the break.
    const { rows } = await pool.query(
      `select activity_id from time_entries
       where employee_id = $1 and entry_type = 'work'
       order by started_at desc limit 1`,
      [d.employeeId]
    );
    const resumeActivityId = rows[0]?.activity_id ?? null;
    if (!resumeActivityId) {
      return res.status(409).json({ error: "No prior activity to resume" });
    }

    await openEntry(d.employeeId, d.id, "work", resumeActivityId, idempotencyKey);
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
  })
);

router.post(
  "/time-entries/end-day",
  asyncHandler(async (req, res) => {
    const d = req.device!;
    await pool.query(
      `update time_entries set ended_at = now() where employee_id = $1 and ended_at is null`,
      [d.employeeId]
    );
    res.json(await serializeStatus(d.employeeId, d.employeeFirstName, d.employeeLastName));
  })
);

export default router;
