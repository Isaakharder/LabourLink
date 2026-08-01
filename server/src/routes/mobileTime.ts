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
  asyncHandler(async (req, res) => {
    const d = req.device!;

    // Resolve the employee's currently open group assignment, joined to an
    // active group — an assignment pointing at an inactive group can't
    // actually happen (activityGroups.ts closes the row on deactivation),
    // but the join filter is kept anyway as defense-in-depth, matching how
    // requireDevice double-checks is_active even after already gating on
    // assignment closure elsewhere.
    const groupRows = await pool.query(
      `select ag.id, ag.name
       from employee_activity_group_assignments eaga
       join activity_groups ag on ag.id = eaga.activity_group_id and ag.is_active = true
       where eaga.employee_id = $1 and eaga.unassigned_at is null`,
      [d.employeeId]
    );
    const group = groupRows.rows[0];
    if (!group) {
      // No active group — never fall back to "all activities."
      return res.json({ activities: [], activityGroup: null });
    }

    const { rows } = await pool.query(
      `select a.id, a.name
       from activity_group_activities aga
       join activities a on a.id = aga.activity_id and a.is_active = true
       where aga.activity_group_id = $1
       order by a.sort_order, a.name`,
      [group.id]
    );
    res.json({ activities: rows, activityGroup: { id: group.id, name: group.name } });
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
    // AND a member of the employee's currently active group before opening
    // an entry against it. Picker restriction is a UI convenience only; this
    // is the actual enforcement, since a client-supplied id is never trusted.
    const activityCheck = await pool.query(
      `select a.id
       from activities a
       join activity_group_activities aga on aga.activity_id = a.id
       join employee_activity_group_assignments eaga
         on eaga.activity_group_id = aga.activity_group_id
        and eaga.employee_id = $2
        and eaga.unassigned_at is null
       join activity_groups ag on ag.id = aga.activity_group_id and ag.is_active = true
       where a.id = $1 and a.is_active = true`,
      [activityId, d.employeeId]
    );
    if (!activityCheck.rows[0]) {
      return res.status(400).json({ error: "activityId is not available to this employee" });
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
