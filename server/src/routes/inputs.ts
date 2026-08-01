import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { getSignedPhotoUrl, getSignedPhotoUrls } from "../lib/storage";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import { groupIntoActivityRuns, RunSegment } from "../lib/activityRuns";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EDIT_ROLES = ["Administrator", "Manager", "Supervisor"];

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

// Supervisor can't call GET /api/employees (Administrator/Manager only,
// and it returns far more PII than a picker needs) — this is a minimal,
// purpose-built list for the Inputs page's employee panel.
router.get(
  "/employees",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const search = trimOrNull(req.query.search as string);
    const conditions = ["e.is_active = true"];
    const params: unknown[] = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`lower(e.first_name || ' ' || e.last_name) like $${params.length}`);
    }

    const { rows } = await pool.query(
      `select e.id, e.first_name, e.last_name, e.profile_photo_path
       from employees e
       where ${conditions.join(" and ")}
       order by e.first_name, e.last_name`,
      params
    );

    const photoPaths = rows.filter((r) => r.profile_photo_path).map((r) => r.profile_photo_path);
    const urlMap = await getSignedPhotoUrls(photoPaths);

    res.json({
      employees: rows.map((r) => ({
        id: r.id,
        firstName: r.first_name,
        lastName: r.last_name,
        photoUrl: r.profile_photo_path ? urlMap.get(r.profile_photo_path) ?? null : null,
      })),
    });
  })
);

router.get(
  "/daily",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const employeeId = req.query.employeeId as string | undefined;
    const date = req.query.date as string | undefined;
    if (!employeeId || !UUID_RE.test(employeeId)) {
      return res.status(400).json({ error: "A valid employeeId is required" });
    }
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "A valid date (YYYY-MM-DD) is required" });
    }

    const empRes = await pool.query(
      "select id, first_name, last_name, profile_photo_path from employees where id = $1",
      [employeeId]
    );
    const employee = empRes.rows[0];
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    const { start, end } = getDayBoundsUtc(date);
    // Not filtered on activities.is_active — activities are never
    // hard-deleted, only deactivated, so filtering here would silently hide
    // legitimate history against a since-deactivated activity.
    const { rows: entryRows } = await pool.query(
      `select te.id, te.entry_type, te.activity_id, te.started_at, te.ended_at,
              a.name as activity_name, a.normal_speed, a.speed_unit
       from time_entries te
       left join activities a on a.id = te.activity_id
       where te.employee_id = $1 and te.started_at >= $2 and te.started_at < $3
       order by te.started_at asc`,
      [employeeId, start, end]
    );

    const segments: RunSegment[] = entryRows.map((r) => ({
      id: r.id,
      entry_type: r.entry_type,
      activity_id: r.activity_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
    }));
    const { runs, breaks } = groupIntoActivityRuns(segments);

    const activityMeta = new Map<string, { name: string; normalSpeed: string | null; speedUnit: string | null }>();
    for (const r of entryRows) {
      if (r.activity_id && !activityMeta.has(r.activity_id)) {
        activityMeta.set(r.activity_id, { name: r.activity_name, normalSpeed: r.normal_speed, speedUnit: r.speed_unit });
      }
    }

    const canEditRole = EDIT_ROLES.includes(req.employee!.securityRole);
    const workStart = entryRows.find((r) => r.entry_type === "work");

    const totalWorkedSeconds = Math.round(runs.reduce((sum, r) => sum + r.durationSeconds, 0));
    const totalBreakSeconds = Math.round(
      breaks.reduce((sum, b) => sum + (b.endedAt ? (b.endedAt.getTime() - b.startedAt.getTime()) / 1000 : 0), 0)
    );

    const photoUrl = employee.profile_photo_path ? await getSignedPhotoUrl(employee.profile_photo_path) : null;

    res.json({
      employee: {
        id: employee.id,
        firstName: employee.first_name,
        lastName: employee.last_name,
        photoUrl,
      },
      date,
      workStartTime: workStart ? workStart.started_at : null,
      runs: runs.map((r) => {
        const meta = activityMeta.get(r.activityId);
        return {
          id: r.id,
          activityId: r.activityId,
          // pg returns numeric columns as strings — cast explicitly, same
          // as server/src/routes/activities.ts.
          activityName: meta?.name ?? "Unknown activity",
          normalSpeedPerHour:
            meta?.normalSpeed != null ? { value: Number(meta.normalSpeed), unit: meta.speedUnit } : null,
          durationSeconds: Math.round(r.durationSeconds),
          startedAt: r.startedAt,
          currentSegmentStartedAt: r.currentSegmentStartedAt,
          endedAt: r.endedAt,
          isOpen: r.isOpen,
          canEdit: canEditRole && !r.isOpen,
        };
      }),
      breaks: breaks.map((b) => ({
        id: b.id,
        startedAt: b.startedAt,
        endedAt: b.endedAt,
        durationSeconds: b.endedAt ? Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 1000) : 0,
      })),
      totals: { workedSeconds: totalWorkedSeconds, breakSeconds: totalBreakSeconds },
      canEdit: canEditRole,
    });
  })
);

router.patch(
  "/activity-runs/:id/end-time",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity run id" });

    const { endTime, reason } = req.body as { endTime?: string; reason?: string };
    const trimmedReason = typeof reason === "string" ? reason.trim() : "";
    if (trimmedReason.length < 3) {
      return res.status(400).json({ error: "A correction reason of at least 3 characters is required" });
    }
    if (!endTime || isNaN(Date.parse(endTime))) {
      return res.status(400).json({ error: "A valid endTime is required" });
    }
    const newEndedAt = new Date(endTime);

    const client = await pool.connect();
    try {
      await client.query("begin");

      // Locked first — always the chronologically-earlier row versus the
      // "next entry" lock below, so two concurrent corrections can never
      // deadlock against each other over lock order.
      const targetRes = await client.query(
        "select id, employee_id, entry_type, started_at, ended_at from time_entries where id = $1 for update",
        [id]
      );
      const target = targetRes.rows[0];
      if (!target) {
        await client.query("rollback");
        return res.status(404).json({ error: "Activity run not found" });
      }
      if (target.entry_type !== "work" || target.ended_at === null) {
        await client.query("rollback");
        return res.status(409).json({ error: "Only a completed work entry can be corrected" });
      }

      const targetStartedAt = new Date(target.started_at);
      const targetEndedAt = new Date(target.ended_at);

      if (calendarDateInAppTimezone(targetStartedAt) !== calendarDateInAppTimezone(newEndedAt)) {
        await client.query("rollback");
        return res.status(422).json({ error: "The corrected end time must be on the same date as the activity" });
      }
      if (newEndedAt.getTime() <= targetStartedAt.getTime()) {
        await client.query("rollback");
        return res.status(422).json({ error: "End time must be after the activity's start time" });
      }

      // Compares against the target row's own started_at via a subquery on
      // its id, not by passing target.started_at (a JS Date) back in as a
      // parameter — node-postgres's timestamptz parser only holds
      // millisecond precision, while Postgres stores microseconds, so a
      // round-tripped Date can be *earlier* than the row's true stored
      // value. That previously let this row match its own "next entry"
      // lookup (its true started_at was > the truncated parameter),
      // corrupting the overlap check below. Same class of bug, same fix
      // pattern already used in mobileTime.ts's previousActivity lookup:
      // let Postgres compare its own stored values directly.
      const nextRes = await client.query(
        `select started_at from time_entries
         where employee_id = $1
           and started_at > (select started_at from time_entries where id = $2)
         order by started_at asc limit 1
         for update`,
        [target.employee_id, id]
      );
      const next = nextRes.rows[0];
      // Equality with the next entry's start is allowed — that's the exact
      // boundary-match convention this app already uses elsewhere
      // (openEntry/accumulateChainSeconds) for "genuinely contiguous," and
      // repairing a chain back into that valid state is the whole point of
      // a correction. Only strictly overlapping past it is rejected.
      if (next && newEndedAt.getTime() > new Date(next.started_at).getTime()) {
        await client.query("rollback");
        return res.status(409).json({ error: "Corrected end time overlaps the next activity or break" });
      }

      await client.query("update time_entries set ended_at = $1 where id = $2", [newEndedAt, id]);
      await client.query(
        `insert into time_entry_corrections
           (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
         values ($1, $2, $3, 'ended_at', $4, $5, $6)`,
        [id, target.employee_id, req.employee!.id, targetEndedAt.toISOString(), newEndedAt.toISOString(), trimmedReason]
      );

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  })
);

export default router;
