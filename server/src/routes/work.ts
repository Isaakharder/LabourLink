import { Router, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { db } from '../db';

export const workRouter = Router();

// ── Internal types ────────────────────────────────────────────────────────────

interface SessionRow {
  id: number;
  employee_id: number;
  site_id: number;
  work_date: string;
  clocked_in_at: Date;
  clocked_out_at: Date | null;
}

interface OpenReg {
  id: number;
  session_id: number;
  activity_id: number;
  activity_code: string;
  activity_name: string;
  activity_color: string | null;
  is_break: boolean;
  location_id: number | null;
  started_at: Date;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function nowOrGiven(v: string | undefined): string {
  return v ?? new Date().toISOString();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Transaction helpers ───────────────────────────────────────────────────────

async function resolveWorkDate(
  client: PoolClient,
  siteId: number,
  occurredAt: string,
): Promise<string> {
  const { rows } = await client.query<{ work_date: string }>(
    `SELECT ($1::timestamptz AT TIME ZONE timezone)::date::text AS work_date
     FROM sites WHERE id = $2`,
    [occurredAt, siteId],
  );
  if (!rows[0]) throw new Error(`Site not found: ${siteId}`);
  return rows[0].work_date;
}

async function getOpenSession(
  client: PoolClient,
  employeeId: number,
): Promise<SessionRow | null> {
  const { rows } = await client.query<SessionRow>(
    `SELECT id, employee_id, site_id, work_date, clocked_in_at, clocked_out_at
     FROM employee_day_sessions
     WHERE employee_id = $1 AND clocked_out_at IS NULL
     FOR UPDATE`,
    [employeeId],
  );
  return rows[0] ?? null;
}

async function getOpenReg(
  client: PoolClient,
  employeeId: number,
): Promise<OpenReg | null> {
  const { rows } = await client.query<{
    id: number; session_id: number; activity_id: number;
    is_break: boolean; location_id: number | null; started_at: Date;
  }>(
    `SELECT id, session_id, activity_id, is_break, location_id, started_at
     FROM work_registrations
     WHERE employee_id = $1 AND ended_at IS NULL AND is_voided = FALSE
     FOR UPDATE`,
    [employeeId],
  );
  if (!rows[0]) return null;
  const r = rows[0];

  const { rows: actRows } = await client.query<{ code: string; name: string; color: string | null }>(
    `SELECT code, name, color FROM activities WHERE id = $1`,
    [r.activity_id],
  );
  const a = actRows[0] ?? { code: '?', name: 'Unknown', color: null };

  return {
    id:             r.id,
    session_id:     r.session_id,
    activity_id:    r.activity_id,
    activity_code:  a.code,
    activity_name:  a.name,
    activity_color: a.color,
    is_break:       r.is_break,
    location_id:    r.location_id,
    started_at:     r.started_at,
  };
}

async function closeReg(
  client: PoolClient,
  regId: number,
  sessionId: number,
  isBreak: boolean,
  occurredAt: string,
  eventId: number,
): Promise<void> {
  const { rows } = await client.query<{ duration_seconds: number }>(
    `UPDATE work_registrations
     SET ended_at           = $1,
         duration_seconds   = GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::integer),
         closed_by_event_id = $2
     WHERE id = $3
     RETURNING duration_seconds`,
    [occurredAt, eventId, regId],
  );
  const dur = rows[0]?.duration_seconds ?? 0;
  const col = isBreak ? 'total_break_seconds' : 'total_reg_seconds';
  await client.query(
    `UPDATE employee_day_sessions
     SET ${col} = ${col} + $1, last_event_at = $2
     WHERE id = $3`,
    [dur, occurredAt, sessionId],
  );
}

async function insertEvent(
  client: PoolClient,
  sessionId: number,
  employeeId: number,
  eventType: string,
  occurredAt: string,
  payload: Record<string, unknown>,
  opts: { activityId?: number | null; locationId?: number | null; isSystem?: boolean } = {},
): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO work_events
       (session_id, employee_id, event_type, occurred_at,
        activity_id, location_id, is_system, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      sessionId, employeeId, eventType, occurredAt,
      opts.activityId  ?? null,
      opts.locationId  ?? null,
      opts.isSystem    ?? false,
      JSON.stringify(payload),
    ],
  );
  return rows[0].id;
}

async function insertReg(
  client: PoolClient,
  sessionId: number,
  employeeId: number,
  siteId: number,
  activityId: number,
  locationId: number | null,
  isBreak: boolean,
  occurredAt: string,
  eventId: number,
): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO work_registrations
       (session_id, employee_id, site_id, activity_id, location_id,
        is_break, started_at, opened_by_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [sessionId, employeeId, siteId, activityId, locationId, isBreak, occurredAt, eventId],
  );
  return rows[0].id;
}

async function activityIsBreak(client: PoolClient, activityId: number): Promise<boolean> {
  const { rows } = await client.query<{ is_break: boolean }>(
    `SELECT (ag.name = 'Breaks') AS is_break
     FROM activities a
     JOIN activity_groups ag ON ag.id = a.activity_group_id
     WHERE a.id = $1`,
    [activityId],
  );
  return rows[0]?.is_break ?? false;
}

async function findActivityByCode(client: PoolClient, code: string): Promise<number | null> {
  const { rows } = await client.query<{ id: number }>(
    `SELECT id FROM activities WHERE code = $1 AND archived_at IS NULL LIMIT 1`,
    [code],
  );
  return rows[0]?.id ?? null;
}

// ── POST /clock-in ────────────────────────────────────────────────────────────

workRouter.post('/clock-in', async (req: Request, res: Response) => {
  const { employeeId, siteId, occurredAt: rawTs } = req.body as {
    employeeId?: number;
    siteId?: number;
    occurredAt?: string;
  };

  if (!employeeId || !siteId) {
    res.status(400).json({ error: 'employeeId and siteId are required' });
    return;
  }

  const occurredAt = nowOrGiven(rawTs);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const workDate = await resolveWorkDate(client, siteId, occurredAt);

    const existing = await getOpenSession(client, employeeId);
    if (existing) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: 'Employee already has an open session',
        sessionId: existing.id,
        workDate: existing.work_date,
      });
      return;
    }

    const { rows: sameDayRows } = await client.query(
      `SELECT id FROM employee_day_sessions WHERE employee_id = $1 AND work_date = $2`,
      [employeeId, workDate],
    );
    if (sameDayRows.length > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Session already exists for this employee on this date' });
      return;
    }

    const { rows: sessionRows } = await client.query<{ id: number }>(
      `INSERT INTO employee_day_sessions
         (employee_id, work_date, site_id, clocked_in_at, last_event_at)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING id`,
      [employeeId, workDate, siteId, occurredAt],
    );
    const sessionId = sessionRows[0].id;

    const eventId = await insertEvent(client, sessionId, employeeId, 'CLOCK_IN', occurredAt, {});

    await client.query('COMMIT');
    res.status(201).json({ sessionId, eventId, workDate, occurredAt });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/work/clock-in', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── POST /start-activity ──────────────────────────────────────────────────────

workRouter.post('/start-activity', async (req: Request, res: Response) => {
  const { employeeId, activityId, locationId = null, occurredAt: rawTs } = req.body as {
    employeeId?: number;
    activityId?: number;
    locationId?: number | null;
    occurredAt?: string;
  };

  if (!employeeId || !activityId) {
    res.status(400).json({ error: 'employeeId and activityId are required' });
    return;
  }

  const occurredAt = nowOrGiven(rawTs);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const session = await getOpenSession(client, employeeId);
    if (!session) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee is not clocked in' });
      return;
    }

    const isBreak = await activityIsBreak(client, activityId);
    const openReg = await getOpenReg(client, employeeId);

    const eventId = await insertEvent(
      client, session.id, employeeId, 'START_ACTIVITY', occurredAt,
      { activity_id: activityId, location_id: locationId },
      { activityId, locationId },
    );

    if (openReg) {
      await closeReg(client, openReg.id, session.id, openReg.is_break, occurredAt, eventId);
    } else {
      await client.query(
        `UPDATE employee_day_sessions SET last_event_at = $1 WHERE id = $2`,
        [occurredAt, session.id],
      );
    }

    const regId = await insertReg(
      client, session.id, employeeId, session.site_id,
      activityId, locationId, isBreak, occurredAt, eventId,
    );

    await client.query('COMMIT');
    res.status(201).json({ eventId, registrationId: regId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/work/start-activity', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── POST /change-location ─────────────────────────────────────────────────────

workRouter.post('/change-location', async (req: Request, res: Response) => {
  const { employeeId, locationId, occurredAt: rawTs } = req.body as {
    employeeId?: number;
    locationId?: number;
    occurredAt?: string;
  };

  if (!employeeId || !locationId) {
    res.status(400).json({ error: 'employeeId and locationId are required' });
    return;
  }

  const occurredAt = nowOrGiven(rawTs);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const session = await getOpenSession(client, employeeId);
    if (!session) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee is not clocked in' });
      return;
    }

    const openReg = await getOpenReg(client, employeeId);
    if (!openReg) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee has no active registration to change location on' });
      return;
    }
    if (openReg.is_break) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Cannot change location while on break' });
      return;
    }

    const eventId = await insertEvent(
      client, session.id, employeeId, 'CHANGE_LOCATION', occurredAt,
      { location_id: locationId },
      { activityId: openReg.activity_id, locationId },
    );

    await closeReg(client, openReg.id, session.id, false, occurredAt, eventId);

    const regId = await insertReg(
      client, session.id, employeeId, session.site_id,
      openReg.activity_id, locationId, false, occurredAt, eventId,
    );

    await client.query('COMMIT');
    res.status(201).json({ eventId, registrationId: regId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/work/change-location', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── POST /start-break ─────────────────────────────────────────────────────────

workRouter.post('/start-break', async (req: Request, res: Response) => {
  const { employeeId, occurredAt: rawTs } = req.body as {
    employeeId?: number;
    occurredAt?: string;
  };

  if (!employeeId) {
    res.status(400).json({ error: 'employeeId is required' });
    return;
  }

  const occurredAt = nowOrGiven(rawTs);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const session = await getOpenSession(client, employeeId);
    if (!session) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee is not clocked in' });
      return;
    }

    const openReg = await getOpenReg(client, employeeId);
    if (openReg?.is_break) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee is already on a break' });
      return;
    }

    const breakActivityId = await findActivityByCode(client, 'BREAK');
    if (!breakActivityId) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: 'BREAK activity not found in system' });
      return;
    }

    const eventId = await insertEvent(
      client, session.id, employeeId, 'START_BREAK', occurredAt,
      { break_activity_id: breakActivityId },
      { activityId: breakActivityId },
    );

    if (openReg) {
      await closeReg(client, openReg.id, session.id, false, occurredAt, eventId);
    } else {
      await client.query(
        `UPDATE employee_day_sessions SET last_event_at = $1 WHERE id = $2`,
        [occurredAt, session.id],
      );
    }

    const regId = await insertReg(
      client, session.id, employeeId, session.site_id,
      breakActivityId, null, true, occurredAt, eventId,
    );

    await client.query('COMMIT');
    res.status(201).json({ eventId, registrationId: regId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/work/start-break', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── POST /start-lunch ─────────────────────────────────────────────────────────

workRouter.post('/start-lunch', async (req: Request, res: Response) => {
  const { employeeId, occurredAt: rawTs } = req.body as {
    employeeId?: number;
    occurredAt?: string;
  };

  if (!employeeId) {
    res.status(400).json({ error: 'employeeId is required' });
    return;
  }

  const occurredAt = nowOrGiven(rawTs);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const session = await getOpenSession(client, employeeId);
    if (!session) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee is not clocked in' });
      return;
    }

    const openReg = await getOpenReg(client, employeeId);
    if (openReg?.is_break) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee is already on a break or lunch' });
      return;
    }

    const lunchActivityId = await findActivityByCode(client, 'LUNCH');
    if (!lunchActivityId) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: 'LUNCH activity not found in system' });
      return;
    }

    const eventId = await insertEvent(
      client, session.id, employeeId, 'START_LUNCH', occurredAt,
      { lunch_activity_id: lunchActivityId },
      { activityId: lunchActivityId },
    );

    if (openReg) {
      await closeReg(client, openReg.id, session.id, false, occurredAt, eventId);
    } else {
      await client.query(
        `UPDATE employee_day_sessions SET last_event_at = $1 WHERE id = $2`,
        [occurredAt, session.id],
      );
    }

    const regId = await insertReg(
      client, session.id, employeeId, session.site_id,
      lunchActivityId, null, true, occurredAt, eventId,
    );

    await client.query('COMMIT');
    res.status(201).json({ eventId, registrationId: regId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/work/start-lunch', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── POST /resume ──────────────────────────────────────────────────────────────

workRouter.post('/resume', async (req: Request, res: Response) => {
  const { employeeId, occurredAt: rawTs } = req.body as {
    employeeId?: number;
    occurredAt?: string;
  };

  if (!employeeId) {
    res.status(400).json({ error: 'employeeId is required' });
    return;
  }

  const occurredAt = nowOrGiven(rawTs);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const session = await getOpenSession(client, employeeId);
    if (!session) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee is not clocked in' });
      return;
    }

    const openReg = await getOpenReg(client, employeeId);
    if (!openReg || !openReg.is_break) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee is not currently on a break' });
      return;
    }

    // Find the most recent non-break registration to resume context
    const { rows: priorRows } = await client.query<{ activity_id: number; location_id: number | null }>(
      `SELECT activity_id, location_id
       FROM work_registrations
       WHERE session_id = $1 AND is_break = FALSE AND is_voided = FALSE
       ORDER BY started_at DESC
       LIMIT 1`,
      [session.id],
    );
    const prior = priorRows[0] ?? null;

    const eventId = await insertEvent(
      client, session.id, employeeId, 'RESUME', occurredAt,
      {
        resumed_activity_id: prior?.activity_id  ?? null,
        resumed_location_id: prior?.location_id  ?? null,
      },
      { activityId: prior?.activity_id, locationId: prior?.location_id },
    );

    await closeReg(client, openReg.id, session.id, true, occurredAt, eventId);

    let regId: number | null = null;
    if (prior) {
      regId = await insertReg(
        client, session.id, employeeId, session.site_id,
        prior.activity_id, prior.location_id, false, occurredAt, eventId,
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      eventId,
      registrationId: regId,
      resumed: prior
        ? { activityId: prior.activity_id, locationId: prior.location_id }
        : null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/work/resume', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── POST /clock-out ───────────────────────────────────────────────────────────

workRouter.post('/clock-out', async (req: Request, res: Response) => {
  const { employeeId, occurredAt: rawTs } = req.body as {
    employeeId?: number;
    occurredAt?: string;
  };

  if (!employeeId) {
    res.status(400).json({ error: 'employeeId is required' });
    return;
  }

  const occurredAt = nowOrGiven(rawTs);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const session = await getOpenSession(client, employeeId);
    if (!session) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Employee is not clocked in' });
      return;
    }

    const openReg = await getOpenReg(client, employeeId);

    const eventId = await insertEvent(
      client, session.id, employeeId, 'CLOCK_OUT', occurredAt, {},
    );

    if (openReg) {
      await closeReg(client, openReg.id, session.id, openReg.is_break, occurredAt, eventId);
    } else {
      await client.query(
        `UPDATE employee_day_sessions SET last_event_at = $1 WHERE id = $2`,
        [occurredAt, session.id],
      );
    }

    await client.query(
      `UPDATE employee_day_sessions SET clocked_out_at = $1 WHERE id = $2`,
      [occurredAt, session.id],
    );

    await client.query('COMMIT');
    res.json({ eventId, sessionId: session.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/work/clock-out', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── GET /input-dashboard ──────────────────────────────────────────────────────

workRouter.get('/input-dashboard', async (req: Request, res: Response) => {
  const dateParam = req.query.date as string | undefined;
  const siteIdParam = req.query.siteId as string | undefined;

  if (dateParam && !DATE_RE.test(dateParam)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }

  const date = dateParam ?? new Date().toISOString().slice(0, 10);
  const siteId = siteIdParam ? parseInt(siteIdParam, 10) : null;

  if (siteIdParam && isNaN(siteId!)) {
    res.status(400).json({ error: 'siteId must be a number' });
    return;
  }

  try {
    const params: (string | number)[] = [date];
    const siteClause = siteId ? (params.push(siteId), `AND s.site_id = $${params.length}`) : '';

    const { rows } = await db.query(
      `SELECT
         s.id                        AS "sessionId",
         e.id                        AS "employeeId",
         e.employee_number           AS "employeeNumber",
         e.first_name                AS "firstName",
         e.last_name                 AS "lastName",
         s.clocked_in_at             AS "clockedInAt",
         s.clocked_out_at            AS "clockedOutAt",
         wr.id                       AS "activeRegId",
         wr.activity_id              AS "activityId",
         a.code                      AS "activityCode",
         a.name                      AS "activityName",
         a.color                     AS "activityColor",
         wr.is_break                 AS "isBreak",
         wr.location_id              AS "locationId",
         l.code                      AS "locationCode",
         l.name                      AS "locationName",
         wr.started_at               AS "currentRegStartedAt",
         CASE
           WHEN s.clocked_out_at IS NOT NULL          THEN 'clocked_out'
           WHEN wr.id IS NULL                         THEN 'idle'
           WHEN wr.is_break AND a.code = 'LUNCH'      THEN 'on_lunch'
           WHEN wr.is_break                           THEN 'on_break'
           ELSE                                            'working'
         END                         AS status,
         COALESCE(totals.reg_seconds,   0) AS "totalRegSeconds",
         COALESCE(totals.break_seconds, 0) AS "totalBreakSeconds"
       FROM employee_day_sessions s
       JOIN employees e ON e.id = s.employee_id
       LEFT JOIN work_registrations wr
         ON wr.session_id = s.id AND wr.ended_at IS NULL AND wr.is_voided = FALSE
       LEFT JOIN activities a ON a.id = wr.activity_id
       LEFT JOIN locations l ON l.id = wr.location_id
       LEFT JOIN LATERAL (
         SELECT
           SUM(duration_seconds) FILTER (WHERE is_break = FALSE) AS reg_seconds,
           SUM(duration_seconds) FILTER (WHERE is_break = TRUE)  AS break_seconds
         FROM work_registrations
         WHERE session_id = s.id AND ended_at IS NOT NULL AND is_voided = FALSE
       ) totals ON TRUE
       WHERE s.work_date = $1
       ${siteClause}
       ORDER BY e.last_name, e.first_name`,
      params,
    );

    res.json({
      date,
      employees: rows.map((r: Record<string, unknown>) => ({
        sessionId:           r.sessionId,
        employeeId:          r.employeeId,
        employeeNumber:      r.employeeNumber,
        firstName:           r.firstName,
        lastName:            r.lastName,
        clockedInAt:         r.clockedInAt,
        clockedOutAt:        r.clockedOutAt,
        status:              r.status,
        currentActivity: r.activityId ? {
          id:    r.activityId,
          code:  r.activityCode,
          name:  r.activityName,
          color: r.activityColor,
        } : null,
        currentLocation: r.locationId ? {
          id:   r.locationId,
          code: r.locationCode,
          name: r.locationName,
        } : null,
        currentRegStartedAt: r.currentRegStartedAt,
        totalRegSeconds:     r.totalRegSeconds,
        totalBreakSeconds:   r.totalBreakSeconds,
      })),
    });
  } catch (err) {
    console.error('GET /api/work/input-dashboard', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /employees/:employeeId/day ────────────────────────────────────────────

workRouter.get('/employees/:employeeId/day', async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.employeeId, 10);
  if (isNaN(employeeId)) {
    res.status(400).json({ error: 'Invalid employeeId' });
    return;
  }

  const dateParam = req.query.date as string | undefined;
  if (dateParam && !DATE_RE.test(dateParam)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  const date = dateParam ?? new Date().toISOString().slice(0, 10);

  try {
    const { rows: sessionRows } = await db.query<{
      id: number; employeeId: number; employeeNumber: string;
      firstName: string; lastName: string;
      workDate: string; clockedInAt: Date; clockedOutAt: Date | null;
    }>(
      `SELECT
         s.id,
         e.id               AS "employeeId",
         e.employee_number  AS "employeeNumber",
         e.first_name       AS "firstName",
         e.last_name        AS "lastName",
         s.work_date        AS "workDate",
         s.clocked_in_at    AS "clockedInAt",
         s.clocked_out_at   AS "clockedOutAt"
       FROM employee_day_sessions s
       JOIN employees e ON e.id = s.employee_id
       WHERE s.employee_id = $1 AND s.work_date = $2`,
      [employeeId, date],
    );

    if (!sessionRows[0]) {
      res.status(404).json({ error: 'No session found for this employee on this date' });
      return;
    }
    const session = sessionRows[0];

    const { rows: regRows } = await db.query<{
      id: number; startedAt: Date; endedAt: Date | null; durationSeconds: number | null;
      activityId: number; activityCode: string; activityName: string; activityColor: string | null;
      locationId: number | null; locationCode: string | null; locationName: string | null;
      carrierId: number | null; isBreak: boolean; isVoided: boolean;
    }>(
      `SELECT
         wr.id,
         wr.started_at           AS "startedAt",
         wr.ended_at             AS "endedAt",
         wr.duration_seconds     AS "durationSeconds",
         wr.activity_id          AS "activityId",
         a.code                  AS "activityCode",
         a.name                  AS "activityName",
         a.color                 AS "activityColor",
         wr.location_id          AS "locationId",
         l.code                  AS "locationCode",
         l.name                  AS "locationName",
         wr.carrier_id           AS "carrierId",
         wr.is_break             AS "isBreak",
         wr.is_voided            AS "isVoided"
       FROM work_registrations wr
       JOIN activities a ON a.id = wr.activity_id
       LEFT JOIN locations l ON l.id = wr.location_id
       WHERE wr.session_id = $1
       ORDER BY wr.started_at ASC`,
      [session.id],
    );

    const closed = regRows.filter(r => r.durationSeconds !== null && !r.isVoided);
    const totalRegSeconds   = closed.filter(r => !r.isBreak).reduce((s, r) => s + (r.durationSeconds ?? 0), 0);
    const totalBreakSeconds = closed.filter(r =>  r.isBreak).reduce((s, r) => s + (r.durationSeconds ?? 0), 0);
    const breaks  = closed.filter(r => r.isBreak && r.activityCode === 'BREAK');
    const lunches = closed.filter(r => r.isBreak && r.activityCode === 'LUNCH');

    res.json({
      session: {
        id:             session.id,
        employeeId:     session.employeeId,
        employeeNumber: session.employeeNumber,
        firstName:      session.firstName,
        lastName:       session.lastName,
        workDate:       session.workDate,
        clockedInAt:    session.clockedInAt,
        clockedOutAt:   session.clockedOutAt,
      },
      registrations: regRows.map(r => ({
        id:              r.id,
        startedAt:       r.startedAt,
        endedAt:         r.endedAt,
        durationSeconds: r.durationSeconds,
        activityId:      r.activityId,
        activityCode:    r.activityCode,
        activityName:    r.activityName,
        activityColor:   r.activityColor,
        locationId:      r.locationId,
        locationCode:    r.locationCode,
        locationName:    r.locationName,
        carrierId:       r.carrierId,
        isBreak:         r.isBreak,
        isVoided:        r.isVoided,
      })),
      summary: {
        clockedInAt:      session.clockedInAt,
        clockedOutAt:     session.clockedOutAt,
        breaks:  breaks.map(b => ({ startedAt: b.startedAt, endedAt: b.endedAt, durationSeconds: b.durationSeconds })),
        lunches: lunches.map(l => ({ startedAt: l.startedAt, endedAt: l.endedAt, durationSeconds: l.durationSeconds })),
        totalRegSeconds,
        totalBreakSeconds,
        totalPaidSeconds: null,
      },
    });
  } catch (err) {
    console.error('GET /api/work/employees/:employeeId/day', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
