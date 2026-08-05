import { Router } from "express";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { getSignedPhotoUrl, getSignedPhotoUrls } from "../lib/storage";
import { calendarDateInAppTimezone, getDayBoundsUtc } from "../lib/timezone";
import { groupIntoActivityRuns, RunSegment } from "../lib/activityRuns";
import { reconcileEmployeeBreaks } from "../lib/breakReconciliation";

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

    // Reconcile scheduled breaks the employee worked straight through before
    // reading the day back — never for a future date (nothing to reconcile
    // yet, and reconcileEmployeeBreaks would just no-op on future-dated
    // items anyway, but skipping avoids the wasted round trip).
    if (date <= calendarDateInAppTimezone(new Date())) {
      await reconcileEmployeeBreaks(employeeId, date);
    }

    const { start, end } = getDayBoundsUtc(date);
    // Not filtered on activities.is_active — activities are never
    // hard-deleted, only deactivated, so filtering here would silently hide
    // legitimate history against a since-deactivated activity.
    // Not filtered on greenhouse_rows.deleted_at/greenhouse_phases.is_active
    // either — same "history always resolves" convention as the
    // unfiltered activities join above.
    const { rows: entryRows } = await pool.query(
      `select te.id, te.entry_type, te.activity_id, te.started_at, te.ended_at,
              te.break_profile_item_id, te.source, te.is_paid, te.greenhouse_row_id,
              a.name as activity_name, a.normal_speed, a.speed_unit,
              bpi.name as break_item_name,
              gr.row_number, gphase.name as row_phase_name
       from time_entries te
       left join activities a on a.id = te.activity_id
       left join break_profile_items bpi on bpi.id = te.break_profile_item_id
       left join greenhouse_rows gr on gr.id = te.greenhouse_row_id
       left join greenhouse_phases gphase on gphase.id = gr.phase_id
       where te.employee_id = $1 and te.started_at >= $2 and te.started_at < $3 and te.deleted_at is null
       order by te.started_at asc`,
      [employeeId, start, end]
    );

    const segments: RunSegment[] = entryRows.map((r) => ({
      id: r.id,
      entry_type: r.entry_type,
      activity_id: r.activity_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      greenhouse_row_id: r.greenhouse_row_id,
    }));
    const { runs, breaks } = groupIntoActivityRuns(segments);

    const activityMeta = new Map<string, { name: string; normalSpeed: string | null; speedUnit: string | null }>();
    const rowMeta = new Map<string, { rowNumber: number; phaseName: string }>();
    // Unclassified/legacy breaks (is_paid null, recorded before this column
    // existed) are bucketed as unpaid — a break must be explicitly marked
    // paid to count as paid, nothing is inferred from duration or time.
    const breakMeta = new Map<
      string,
      { name: string | null; isPaid: boolean | null; source: "manual" | "auto"; breakProfileItemId: string | null }
    >();
    for (const r of entryRows) {
      if (r.activity_id && !activityMeta.has(r.activity_id)) {
        activityMeta.set(r.activity_id, { name: r.activity_name, normalSpeed: r.normal_speed, speedUnit: r.speed_unit });
      }
      if (r.greenhouse_row_id && !rowMeta.has(r.greenhouse_row_id)) {
        rowMeta.set(r.greenhouse_row_id, { rowNumber: r.row_number, phaseName: r.row_phase_name });
      }
      if (r.entry_type === "break") {
        breakMeta.set(r.id, {
          name: r.break_item_name ?? null,
          isPaid: r.is_paid,
          source: r.source,
          breakProfileItemId: r.break_profile_item_id,
        });
      }
    }

    const canEditRole = EDIT_ROLES.includes(req.employee!.securityRole);
    const workStart = entryRows.find((r) => r.entry_type === "work");

    const totalWorkedSeconds = Math.round(runs.reduce((sum, r) => sum + r.durationSeconds, 0));
    const totalBreakSeconds = Math.round(
      breaks.reduce((sum, b) => sum + (b.endedAt ? (b.endedAt.getTime() - b.startedAt.getTime()) / 1000 : 0), 0)
    );
    let totalPaidBreakSeconds = 0;
    let totalUnpaidBreakSeconds = 0;
    for (const b of breaks) {
      const dur = b.endedAt ? Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 1000) : 0;
      if (breakMeta.get(b.id)?.isPaid) totalPaidBreakSeconds += dur;
      else totalUnpaidBreakSeconds += dur;
    }

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
        const row = r.greenhouseRowId ? rowMeta.get(r.greenhouseRowId) : undefined;
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
          row: row ? { id: r.greenhouseRowId, label: `${row.phaseName} · Row ${row.rowNumber}` } : null,
        };
      }),
      breaks: breaks.map((b) => {
        const meta = breakMeta.get(b.id);
        return {
          id: b.id,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          durationSeconds: b.endedAt ? Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 1000) : 0,
          name: meta?.name ?? null,
          isPaid: meta?.isPaid ?? null,
          source: meta?.source ?? "manual",
          breakProfileItemId: meta?.breakProfileItemId ?? null,
          // Same rule as an activity run: role-gated, and only once it's
          // closed — an open break can't be edited or deleted from here.
          canEdit: canEditRole && b.endedAt !== null,
        };
      }),
      totals: {
        workedSeconds: totalWorkedSeconds,
        breakSeconds: totalBreakSeconds,
        paidBreakSeconds: totalPaidBreakSeconds,
        unpaidBreakSeconds: totalUnpaidBreakSeconds,
      },
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
        "select id, employee_id, entry_type, started_at, ended_at from time_entries where id = $1 and deleted_at is null for update",
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
           and deleted_at is null
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

router.post(
  "/activity-runs/:id/delete",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid activity run id" });

    const { reason } = req.body as { reason?: string };
    const trimmedReason = typeof reason === "string" ? reason.trim() : "";
    if (trimmedReason.length < 3) {
      return res.status(400).json({ error: "A deletion reason of at least 3 characters is required" });
    }

    // Unlocked peek: the client only ever knows a run by its last segment's
    // id (ActivityRun.id — see activityRuns.ts), never the full set of
    // underlying time_entries rows a multi-fragment run is made of. Re-derive
    // that set the same way GET /daily does (regroup that employee's whole
    // day), then lock and delete every segment together.
    const peek = await pool.query(
      `select employee_id, entry_type, started_at, ended_at, deleted_at from time_entries where id = $1`,
      [id]
    );
    const peekRow = peek.rows[0];
    if (!peekRow || peekRow.deleted_at) {
      return res.status(404).json({ error: "Activity log not found" });
    }
    if (peekRow.entry_type !== "work") {
      return res.status(409).json({ error: "Only a work activity log can be deleted" });
    }
    if (peekRow.ended_at === null) {
      return res.status(409).json({ error: "An in-progress activity cannot be deleted from this screen" });
    }

    const dateStr = calendarDateInAppTimezone(new Date(peekRow.started_at));
    const { start, end } = getDayBoundsUtc(dateStr);
    const dayRows = await pool.query(
      `select id, entry_type, activity_id, started_at, ended_at, greenhouse_row_id
       from time_entries
       where employee_id = $1 and started_at >= $2 and started_at < $3 and deleted_at is null
       order by started_at asc`,
      [peekRow.employee_id, start, end]
    );
    const segments: RunSegment[] = dayRows.rows.map((r) => ({
      id: r.id,
      entry_type: r.entry_type,
      activity_id: r.activity_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      greenhouse_row_id: r.greenhouse_row_id,
    }));
    const { runs } = groupIntoActivityRuns(segments);
    const run = runs.find((r) => r.id === id);
    if (!run || run.isOpen) {
      return res.status(409).json({ error: "An in-progress activity cannot be deleted from this screen" });
    }

    // segmentIds is already in started_at-ascending order (groupIntoActivityRuns
    // builds it by iterating entries in that order) — locking in that same
    // order keeps this consistent with every other place in this file that
    // might lock more than one time_entries row, so nothing here can
    // deadlock against a concurrent correction or another deletion.
    const segmentIds = run.segmentIds;

    const client = await pool.connect();
    try {
      await client.query("begin");

      for (const segId of segmentIds) {
        const r = await client.query(
          `select id from time_entries where id = $1 and deleted_at is null and entry_type = 'work' for update`,
          [segId]
        );
        if (!r.rows[0]) {
          // A segment of this run was deleted or changed by someone else
          // since it was loaded — bail out rather than deleting a partial,
          // now-inconsistent subset of the run.
          await client.query("rollback");
          return res
            .status(409)
            .json({ error: "This activity log changed since it was loaded — please refresh and try again" });
        }
      }

      await client.query(
        `update time_entries
         set deleted_at = now(), deleted_by_employee_id = $1, deletion_reason = $2
         where id = any($3::uuid[])`,
        [req.employee!.id, trimmedReason, segmentIds]
      );
      await client.query(
        `insert into time_entry_deletions
           (employee_id, deleted_by_employee_id, deletion_type, affected_time_entry_ids, reason)
         values ($1, $2, 'activity_run', $3, $4)`,
        [peekRow.employee_id, req.employee!.id, segmentIds, trimmedReason]
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

router.patch(
  "/breaks/:id",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid break id" });

    const { startTime, endTime, reason } = req.body as { startTime?: string; endTime?: string; reason?: string };
    const trimmedReason = typeof reason === "string" ? reason.trim() : "";
    if (trimmedReason.length < 3) {
      return res.status(400).json({ error: "A correction reason of at least 3 characters is required" });
    }
    if (startTime === undefined && endTime === undefined) {
      return res.status(400).json({ error: "startTime and/or endTime is required" });
    }
    if (startTime !== undefined && (typeof startTime !== "string" || isNaN(Date.parse(startTime)))) {
      return res.status(400).json({ error: "A valid startTime is required" });
    }
    if (endTime !== undefined && (typeof endTime !== "string" || isNaN(Date.parse(endTime)))) {
      return res.status(400).json({ error: "A valid endTime is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      // Unlocked peek, needed to know which adjacent work rows (if any)
      // must also be locked, and in the right chronological order, before
      // any row is actually locked. Re-validated against the real locked
      // read of the break itself below.
      const peek = await client.query(
        `select employee_id, entry_type, started_at, ended_at, deleted_at
         from time_entries where id = $1`,
        [id]
      );
      const peekRow = peek.rows[0];
      if (!peekRow || peekRow.deleted_at) {
        await client.query("rollback");
        return res.status(404).json({ error: "Break not found" });
      }
      if (peekRow.entry_type !== "break") {
        await client.query("rollback");
        return res.status(409).json({ error: "Only a break can be corrected here" });
      }
      if (peekRow.ended_at === null) {
        await client.query("rollback");
        return res.status(409).json({ error: "An in-progress break cannot be corrected here" });
      }

      // Compared via a subquery on this break's own id, not by passing
      // peekRow.started_at back in as a parameter — node-postgres's
      // timestamptz parser only holds millisecond precision, while Postgres
      // stores microseconds, so a round-tripped Date can silently fail to
      // match a genuinely contiguous neighbor whose boundary was set via
      // now() (see the identical fix already applied in mobileTime.ts's
      // previousActivity lookup and this file's own end-time correction
      // route above).
      const precedingPeek = await client.query(
        `select id from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and ended_at = (select started_at from time_entries where id = $2)`,
        [peekRow.employee_id, id]
      );

      // Chronological lock order: preceding work entry (if any) first, then
      // the break itself, then the following work entry (if any) last —
      // the same order every code path in this file uses whenever it might
      // lock more than one time_entries row, so two concurrent corrections
      // can never deadlock against each other over lock order.
      let preceding: { id: string; started_at: string; ended_at: string } | null = null;
      if (precedingPeek.rows[0]) {
        const r = await client.query(
          `select id, started_at, ended_at from time_entries where id = $1 and deleted_at is null for update`,
          [precedingPeek.rows[0].id]
        );
        preceding = r.rows[0] ?? null;
      }

      const targetRes = await client.query(
        `select id, employee_id, started_at, ended_at from time_entries
         where id = $1 and entry_type = 'break' and deleted_at is null for update`,
        [id]
      );
      const target = targetRes.rows[0];
      if (!target || target.ended_at === null) {
        await client.query("rollback");
        return res
          .status(409)
          .json({ error: "This break changed since it was loaded — please refresh and try again" });
      }

      // Same subquery-based comparison as precedingPeek above, for the same
      // precision reason.
      const followingPeek = await client.query(
        `select id from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and started_at = (select ended_at from time_entries where id = $2)`,
        [target.employee_id, id]
      );
      let following: { id: string; started_at: string; ended_at: string | null } | null = null;
      if (followingPeek.rows[0]) {
        const r = await client.query(
          `select id, started_at, ended_at from time_entries where id = $1 and deleted_at is null for update`,
          [followingPeek.rows[0].id]
        );
        following = r.rows[0] ?? null;
      }

      const oldStart = new Date(target.started_at);
      const oldEnd = new Date(target.ended_at);
      const newStart = startTime !== undefined ? new Date(startTime) : oldStart;
      const newEnd = endTime !== undefined ? new Date(endTime) : oldEnd;

      if (newStart.getTime() >= newEnd.getTime()) {
        await client.query("rollback");
        return res.status(422).json({ error: "Start time must be before end time" });
      }
      if (
        calendarDateInAppTimezone(oldStart) !== calendarDateInAppTimezone(newStart) ||
        calendarDateInAppTimezone(oldStart) !== calendarDateInAppTimezone(newEnd)
      ) {
        await client.query("rollback");
        return res.status(422).json({ error: "The corrected times must stay on the same date as the break" });
      }

      // No overlap with any OTHER break.
      const overlap = await client.query(
        `select id from time_entries
         where employee_id = $1 and entry_type = 'break' and deleted_at is null and id <> $2
           and started_at < $3 and (ended_at is null or ended_at > $4)
         limit 1`,
        [target.employee_id, id, newEnd, newStart]
      );
      if (overlap.rows[0]) {
        await client.query("rollback");
        return res.status(409).json({ error: "Corrected break overlaps another break" });
      }

      // No overlap with any work entry either — preceding/following are
      // excluded since they're the two entries this correction is allowed
      // to legitimately touch/reattach to (validated separately below).
      // This is a safety net beyond the preceding/following-specific checks
      // — e.g. if a gap already existed further out (from an earlier
      // deletion), a large correction shouldn't be able to reach into it.
      const workOverlap = await client.query(
        `select id from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and id <> all($2::uuid[])
           and started_at < $3 and (ended_at is null or ended_at > $4)
         limit 1`,
        [target.employee_id, [preceding?.id, following?.id].filter((v): v is string => Boolean(v)), newEnd, newStart]
      );
      if (workOverlap.rows[0]) {
        await client.query("rollback");
        return res.status(409).json({ error: "Corrected break overlaps a work entry" });
      }

      // Timeline repair validation: a moved boundary can't erase the
      // adjacent activity segment it would reattach to.
      if (preceding && newStart.getTime() !== oldStart.getTime()) {
        if (newStart.getTime() <= new Date(preceding.started_at).getTime()) {
          await client.query("rollback");
          return res
            .status(422)
            .json({ error: "Corrected start time would leave no time for the preceding activity" });
        }
      }
      if (following && following.ended_at !== null && newEnd.getTime() !== oldEnd.getTime()) {
        if (newEnd.getTime() >= new Date(following.ended_at).getTime()) {
          await client.query("rollback");
          return res
            .status(422)
            .json({ error: "Corrected end time would leave no time for the following activity" });
        }
      }
      // The following work entry is still open (in progress) — there's no
      // ended_at to bound the correction against above, but pushing its
      // started_at into the future would still corrupt it: an in-progress
      // entry whose clock hasn't started yet breaks its own live timer and
      // every duration computed from it.
      if (following && following.ended_at === null && newEnd.getTime() !== oldEnd.getTime()) {
        if (newEnd.getTime() > Date.now()) {
          await client.query("rollback");
          return res
            .status(422)
            .json({ error: "Corrected end time cannot be in the future while the following activity is still in progress" });
        }
      }

      await client.query(`update time_entries set started_at = $1, ended_at = $2 where id = $3`, [
        newStart,
        newEnd,
        id,
      ]);

      // Every affected timestamp — the break's own boundary plus whichever
      // adjacent work entry got dragged along with it — gets its own audit
      // row, same shape as the existing end-time correction. Metadata this
      // break carries (break_profile_item_id, scheduled_break_date, source,
      // is_paid) is never touched here, preserving it exactly as the task
      // requires for an auto-added/fixed-matched break.
      const auditInsert = (entryId: string, field: "started_at" | "ended_at", oldVal: Date, newVal: Date) =>
        client.query(
          `insert into time_entry_corrections
             (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [entryId, target.employee_id, req.employee!.id, field, oldVal.toISOString(), newVal.toISOString(), trimmedReason]
        );

      if (newStart.getTime() !== oldStart.getTime()) {
        await auditInsert(id, "started_at", oldStart, newStart);
        if (preceding) {
          await client.query(`update time_entries set ended_at = $1 where id = $2`, [newStart, preceding.id]);
          await auditInsert(preceding.id, "ended_at", new Date(preceding.ended_at), newStart);
        }
      }
      if (newEnd.getTime() !== oldEnd.getTime()) {
        await auditInsert(id, "ended_at", oldEnd, newEnd);
        if (following) {
          await client.query(`update time_entries set started_at = $1 where id = $2`, [newEnd, following.id]);
          await auditInsert(following.id, "started_at", new Date(following.started_at), newEnd);
        }
      }

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

router.post(
  "/breaks/:id/delete",
  requireAuth,
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid break id" });

    const { reason } = req.body as { reason?: string };
    const trimmedReason = typeof reason === "string" ? reason.trim() : "";
    if (trimmedReason.length < 3) {
      return res.status(400).json({ error: "A deletion reason of at least 3 characters is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const peek = await client.query(
        `select employee_id, entry_type, started_at, ended_at, deleted_at,
                break_profile_item_id, to_char(scheduled_break_date, 'YYYY-MM-DD') as scheduled_break_date, source
         from time_entries where id = $1`,
        [id]
      );
      const peekRow = peek.rows[0];
      if (!peekRow || peekRow.deleted_at) {
        await client.query("rollback");
        return res.status(404).json({ error: "Break not found" });
      }
      if (peekRow.entry_type !== "break") {
        await client.query("rollback");
        return res.status(409).json({ error: "Only a break can be deleted here" });
      }
      if (peekRow.ended_at === null) {
        await client.query("rollback");
        return res.status(409).json({ error: "An in-progress break cannot be deleted from this screen" });
      }

      // Subquery-based comparison, not a round-tripped Date parameter — see
      // the identical fix (and its rationale) in the PATCH handler above.
      const precedingPeek = await client.query(
        `select id, activity_id from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and ended_at = (select started_at from time_entries where id = $2)`,
        [peekRow.employee_id, id]
      );
      const followingPeek = await client.query(
        `select id, activity_id from time_entries
         where employee_id = $1 and entry_type = 'work' and deleted_at is null
           and started_at = (select ended_at from time_entries where id = $2)`,
        [peekRow.employee_id, id]
      );

      // Different activities on either side: never guess how to bridge the
      // gap — reject and ask the supervisor to correct the adjacent
      // activity's times (or delete one of them) first.
      if (
        precedingPeek.rows[0] &&
        followingPeek.rows[0] &&
        precedingPeek.rows[0].activity_id !== followingPeek.rows[0].activity_id
      ) {
        await client.query("rollback");
        return res.status(409).json({
          error:
            "This break sits between two different activities and can't be safely removed automatically. " +
            "Correct the adjacent activity's times first, or delete one of them, before removing this break.",
        });
      }

      // Chronological lock order (see the PATCH handler above for why).
      let preceding: { id: string } | null = null;
      if (precedingPeek.rows[0]) {
        const r = await client.query(`select id from time_entries where id = $1 and deleted_at is null for update`, [
          precedingPeek.rows[0].id,
        ]);
        preceding = r.rows[0] ?? null;
      }

      const targetRes = await client.query(
        `select id, employee_id, ended_at from time_entries
         where id = $1 and entry_type = 'break' and deleted_at is null for update`,
        [id]
      );
      const target = targetRes.rows[0];
      if (!target || target.ended_at === null) {
        await client.query("rollback");
        return res
          .status(409)
          .json({ error: "This break changed since it was loaded — please refresh and try again" });
      }

      let following: { id: string } | null = null;
      if (followingPeek.rows[0]) {
        const r = await client.query(`select id from time_entries where id = $1 and deleted_at is null for update`, [
          followingPeek.rows[0].id,
        ]);
        following = r.rows[0] ?? null;
      }

      // Reconnect only when both sides survived the lock and are still the
      // same activity — extend the preceding entry to meet the following
      // one exactly, the reverse of how reconcileEmployeeBreaks shrinks a
      // work entry to carve an auto-added break out of it. A break at the
      // start or end of the day (only one side, or neither) is just
      // deleted outright: there's nothing to reconnect, and — deliberately
      // — the single remaining neighbor's own boundary is left untouched
      // rather than guessed at (see report for this chosen behavior).
      if (preceding && following) {
        // Set via a subquery on the break's own id rather than passing
        // target.ended_at back in as a parameter, so preceding.ended_at
        // ends up bit-identical to the value following.started_at already
        // holds (same precision reasoning as the lookups above) instead of
        // a millisecond-truncated copy of it.
        await client.query(
          `update time_entries set ended_at = (select ended_at from time_entries where id = $1) where id = $2`,
          [id, preceding.id]
        );
        await client.query(
          `insert into time_entry_corrections
             (time_entry_id, employee_id, changed_by_employee_id, field_name, old_value, new_value, reason)
           values ($1, $2, $3, 'ended_at', $4, $5, $6)`,
          [
            preceding.id,
            peekRow.employee_id,
            req.employee!.id,
            new Date(peekRow.started_at).toISOString(),
            new Date(target.ended_at).toISOString(),
            trimmedReason,
          ]
        );
      }

      await client.query(
        `update time_entries
         set deleted_at = now(), deleted_by_employee_id = $1, deletion_reason = $2
         where id = $3`,
        [req.employee!.id, trimmedReason, id]
      );
      await client.query(
        `insert into time_entry_deletions
           (employee_id, deleted_by_employee_id, deletion_type, affected_time_entry_ids, reason)
         values ($1, $2, 'break', $3, $4)`,
        [peekRow.employee_id, req.employee!.id, [id], trimmedReason]
      );

      // Suppress reconciliation from recreating this break on the next
      // status fetch or Inputs load — for ANY break tied to a scheduled
      // item, not just ones recorded with source='auto'. A manual break
      // that landed inside a fixed item's grace window (mobileTime.ts's
      // break/start) is tagged with the same break_profile_item_id/
      // scheduled_break_date, and the reconnect step just above can
      // re-merge the surrounding work entries back into a single span that
      // fully covers the scheduled window again — at which point
      // reconcileEmployeeBreaks would see that window as unaccounted-for
      // and re-add it (as a new 'auto' entry) unless suppressed here.
      // Freeform manual breaks (no break_profile_item_id at all) never
      // match reconciliation's schedule-driven checks in the first place,
      // so they correctly never need a row here.
      if (peekRow.break_profile_item_id && peekRow.scheduled_break_date) {
        await client.query(
          `insert into break_schedule_exceptions
             (employee_id, break_profile_item_id, scheduled_date, reason, created_by_employee_id)
           values ($1, $2, $3, $4, $5)
           on conflict (employee_id, break_profile_item_id, scheduled_date) do nothing`,
          [peekRow.employee_id, peekRow.break_profile_item_id, peekRow.scheduled_break_date, trimmedReason, req.employee!.id]
        );
      }

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
