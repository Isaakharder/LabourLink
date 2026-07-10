import { Router, Request, Response } from 'express';
import { db } from '../db';
import { requirePermission } from '../middleware/auth';
import { employeeBelongsToCompany, siteBelongsToCompany, contractTemplateBelongsToCompany } from '../lib/companyScope';

export const employeesRouter = Router();

// ── List ──────────────────────────────────────────────────────────────────────
employeesRouter.get('/', requirePermission('employees:view'), async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT
        e.id,
        e.employee_number             AS "employeeNumber",
        e.first_name                  AS "firstName",
        e.last_name                   AS "lastName",
        CASE
          WHEN e.archived_at IS NOT NULL THEN 'archived'
          WHEN er.id         IS NOT NULL THEN 'active'
          ELSE                               'inactive'
        END                           AS status,
        ct.name                       AS contract,
        jr.name                       AS "jobRole",
        s.name                        AS site
      FROM employees e
      LEFT JOIN employment_records er
        ON er.employee_id = e.id AND er.ended_on IS NULL
      LEFT JOIN contract_templates ct ON ct.id = er.contract_template_id
      LEFT JOIN job_roles          jr ON jr.id  = er.job_role_id
      LEFT JOIN sites               s  ON s.id   = er.site_id
      WHERE EXISTS (
        SELECT 1 FROM employment_records er2
        JOIN sites s2 ON s2.id = er2.site_id
        WHERE er2.employee_id = e.id AND s2.company_id = $1
      )
      ORDER BY e.last_name, e.first_name
    `, [req.user!.companyId]);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/employees', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Form options  (must come before /:id so it isn't caught as an id param) ──
employeesRouter.get('/form-options', requirePermission('employees:view'), async (req: Request, res: Response) => {
  try {
    const [sites, securityRoles, jobRoles, contracts] = await Promise.all([
      db.query(`SELECT id, name FROM sites WHERE archived_at IS NULL AND company_id = $1 ORDER BY name`, [req.user!.companyId]),
      db.query(`SELECT id, name FROM security_roles  WHERE archived_at IS NULL ORDER BY sort_order`),
      db.query(`SELECT id, name FROM job_roles        WHERE archived_at IS NULL ORDER BY sort_order`),
      db.query(`SELECT id, name FROM contract_templates WHERE archived_at IS NULL AND company_id = $1 ORDER BY name`, [req.user!.companyId]),
    ]);
    res.json({
      sites:             sites.rows,
      securityRoles:     securityRoles.rows,
      jobRoles:          jobRoles.rows,
      contractTemplates: contracts.rows,
    });
  } catch (err) {
    console.error('GET /api/employees/form-options', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Detail ────────────────────────────────────────────────────────────────────
employeesRouter.get('/:id', requirePermission('employees:view'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  if (!(await employeeBelongsToCompany(id, req.user!.companyId))) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  try {
    const [baseResult, careerResult, devicesResult] = await Promise.all([
      db.query<{
        id: number; employeeNumber: string; firstName: string; lastName: string;
        dateOfBirth: string | null; phone: string | null; email: string | null;
        notes: string | null; archivedAt: Date | null; erCurrentId: number | null;
        employmentStartDate: string | null; site: string | null; contract: string | null;
        jobRole: string | null; team: string | null; supervisor: string | null;
        securityRole: string | null; hasPin: boolean; lastLoginAt: Date | null;
      }>(`
        SELECT
          e.id,
          e.employee_number             AS "employeeNumber",
          e.first_name                  AS "firstName",
          e.last_name                   AS "lastName",
          e.date_of_birth               AS "dateOfBirth",
          e.phone,
          e.email,
          e.notes,
          e.archived_at                 AS "archivedAt",
          er.id                         AS "erCurrentId",
          er.started_on                 AS "employmentStartDate",
          s.name                        AS site,
          ct.name                       AS contract,
          jr.name                       AS "jobRole",
          t.name                        AS team,
          CASE WHEN sup.id IS NOT NULL
            THEN CONCAT(sup.first_name, ' ', sup.last_name)
          END                           AS supervisor,
          sr.name                       AS "securityRole",
          (ec.pin_hash IS NOT NULL)     AS "hasPin",
          (SELECT MAX(logged_in_at)
           FROM device_login_history
           WHERE employee_id = e.id)   AS "lastLoginAt"
        FROM employees e
        LEFT JOIN employment_records er
          ON er.employee_id = e.id AND er.ended_on IS NULL
        LEFT JOIN sites               s   ON s.id   = er.site_id
        LEFT JOIN contract_templates  ct  ON ct.id  = er.contract_template_id
        LEFT JOIN job_roles           jr  ON jr.id  = er.job_role_id
        LEFT JOIN teams               t   ON t.id   = er.team_id
        LEFT JOIN employees           sup ON sup.id = er.supervisor_id
        LEFT JOIN employee_security_role_assignments esra
          ON esra.employee_id = e.id AND esra.ended_at IS NULL
        LEFT JOIN security_roles      sr  ON sr.id  = esra.security_role_id
        LEFT JOIN employee_credentials ec ON ec.employee_id = e.id
        WHERE e.id = $1
      `, [id]),

      db.query<{
        id: number; site: string | null; jobRole: string | null; contract: string | null;
        team: string | null; supervisor: string | null; startedOn: string; endedOn: string | null;
      }>(`
        SELECT
          er.id,
          s.name    AS site,
          jr.name   AS "jobRole",
          ct.name   AS contract,
          t.name    AS team,
          CASE WHEN sup.id IS NOT NULL
            THEN CONCAT(sup.first_name, ' ', sup.last_name)
          END       AS supervisor,
          er.started_on   AS "startedOn",
          er.ended_on     AS "endedOn"
        FROM employment_records er
        LEFT JOIN sites               s   ON s.id   = er.site_id
        LEFT JOIN job_roles           jr  ON jr.id  = er.job_role_id
        LEFT JOIN contract_templates  ct  ON ct.id  = er.contract_template_id
        LEFT JOIN teams               t   ON t.id   = er.team_id
        LEFT JOIN employees           sup ON sup.id = er.supervisor_id
        WHERE er.employee_id = $1
        ORDER BY er.started_on DESC
      `, [id]),

      db.query<{
        id: number; name: string; identifier: string; isShared: boolean;
        assignedSince: Date; assignedUntil: Date | null;
      }>(`
        SELECT
          d.id,
          d.name,
          d.identifier,
          d.is_shared     AS "isShared",
          da.started_at   AS "assignedSince",
          da.ended_at     AS "assignedUntil"
        FROM device_assignments da
        JOIN devices d ON d.id = da.device_id
        WHERE da.employee_id = $1
        ORDER BY da.started_at DESC
      `, [id]),
    ]);

    if (baseResult.rows.length === 0) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    const row = baseResult.rows[0];

    let status: 'active' | 'inactive' | 'archived';
    if (row.archivedAt)    status = 'archived';
    else if (row.erCurrentId) status = 'active';
    else                   status = 'inactive';

    res.json({
      id:                  row.id,
      employeeNumber:      row.employeeNumber,
      firstName:           row.firstName,
      lastName:            row.lastName,
      status,
      dateOfBirth:         row.dateOfBirth   ?? null,
      phone:               row.phone         ?? null,
      email:               row.email         ?? null,
      notes:               row.notes         ?? null,
      site:                row.site          ?? null,
      contract:            row.contract      ?? null,
      jobRole:             row.jobRole       ?? null,
      team:                row.team          ?? null,
      supervisor:          row.supervisor    ?? null,
      employmentStartDate: row.employmentStartDate ?? null,
      securityRole:        row.securityRole  ?? null,
      hasPin:              row.hasPin        ?? false,
      lastLoginAt:         row.lastLoginAt   ? new Date(row.lastLoginAt).toISOString() : null,
      careerHistory: careerResult.rows.map(r => ({
        id:         r.id,
        site:       r.site       ?? null,
        jobRole:    r.jobRole    ?? null,
        contract:   r.contract   ?? null,
        team:       r.team       ?? null,
        supervisor: r.supervisor ?? null,
        startedOn:  r.startedOn,
        endedOn:    r.endedOn    ?? null,
      })),
      devices: devicesResult.rows.map(r => ({
        id:            r.id,
        name:          r.name,
        identifier:    r.identifier,
        isShared:      r.isShared,
        assignedSince: new Date(r.assignedSince).toISOString(),
        assignedUntil: r.assignedUntil ? new Date(r.assignedUntil).toISOString() : null,
      })),
      timeline: [],
    });
  } catch (err) {
    console.error('GET /api/employees/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────
employeesRouter.post('/', requirePermission('employees:edit'), async (req: Request, res: Response) => {
  const { firstName, lastName, dateOfBirth, phone, email,
          siteId, startedOn, jobRoleId, contractTemplateId, securityRoleId } = req.body as {
    firstName: string; lastName: string; dateOfBirth?: string; phone?: string; email?: string;
    siteId: number; startedOn: string; jobRoleId?: number;
    contractTemplateId?: number; securityRoleId?: number;
  };

  if (!firstName || !lastName || !siteId || !startedOn) {
    res.status(400).json({ error: 'firstName, lastName, siteId, and startedOn are required' });
    return;
  }
  if (!(await siteBelongsToCompany(siteId, req.user!.companyId))) {
    res.status(400).json({ error: 'Invalid siteId' });
    return;
  }
  if (contractTemplateId && !(await contractTemplateBelongsToCompany(contractTemplateId, req.user!.companyId))) {
    res.status(400).json({ error: 'Invalid contractTemplateId' });
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const empResult = await client.query<{ id: number; employeeNumber: string }>(`
      INSERT INTO employees (employee_number, first_name, last_name, date_of_birth, phone, email)
      VALUES (
        'EMP-' || LPAD(nextval('employee_number_seq')::text, 4, '0'),
        $1, $2, $3, $4, $5
      )
      RETURNING id, employee_number AS "employeeNumber"
    `, [firstName, lastName, dateOfBirth || null, phone || null, email || null]);

    const { id, employeeNumber } = empResult.rows[0];

    await client.query(
      `INSERT INTO employee_credentials (employee_id) VALUES ($1)`,
      [id],
    );

    const roleResult = securityRoleId
      ? await client.query<{ id: number }>(`SELECT id FROM security_roles WHERE id = $1`, [securityRoleId])
      : await client.query<{ id: number }>(`SELECT id FROM security_roles WHERE is_default = TRUE LIMIT 1`);

    const roleId = roleResult.rows[0]?.id;
    if (!roleId) throw new Error('No security role found');

    await client.query(
      `INSERT INTO employee_security_role_assignments (employee_id, security_role_id) VALUES ($1, $2)`,
      [id, roleId],
    );

    await client.query(
      `INSERT INTO employment_records (employee_id, site_id, job_role_id, contract_template_id, started_on)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, siteId, jobRoleId || null, contractTemplateId || null, startedOn],
    );

    await client.query('COMMIT');
    res.status(201).json({ id, employeeNumber });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/employees', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Update ────────────────────────────────────────────────────────────────────
employeesRouter.patch('/:id', requirePermission('employees:edit'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  if (!(await employeeBelongsToCompany(id, req.user!.companyId))) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  const dbCols: Record<string, string> = {
    firstName:   'first_name',
    lastName:    'last_name',
    dateOfBirth: 'date_of_birth',
    phone:       'phone',
    email:       'email',
    notes:       'notes',
  };

  const sets: string[] = [];
  const params: unknown[] = [];

  for (const key of Object.keys(dbCols)) {
    if (key in req.body) {
      params.push(req.body[key] ?? null);
      sets.push(`${dbCols[key]} = $${params.length}`);
    }
  }

  if (sets.length === 0) {
    res.status(400).json({ error: 'No valid fields to update' });
    return;
  }

  try {
    params.push(id);
    const result = await db.query(
      `UPDATE employees SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Employee not found' }); return; }
    res.json({ id });
  } catch (err) {
    console.error('PATCH /api/employees/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Change Contract ───────────────────────────────────────────────────────────
// Ends the current employment record and opens a new one with the selected contract.
// History is preserved — old record is never deleted or overwritten.

employeesRouter.post('/:id/change-contract', requirePermission('employees:edit'), async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.id, 10);
  if (isNaN(employeeId)) { res.status(400).json({ error: 'Invalid employee id' }); return; }
  if (!(await employeeBelongsToCompany(employeeId, req.user!.companyId))) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  const { contractTemplateId, effectiveDate, notes = 'Contract Change' } = req.body as {
    contractTemplateId?: number;
    effectiveDate?: string;
    notes?: string;
  };

  if (!contractTemplateId || !effectiveDate) {
    res.status(400).json({ error: 'contractTemplateId and effectiveDate are required' });
    return;
  }
  if (!(await contractTemplateBelongsToCompany(contractTemplateId, req.user!.companyId))) {
    res.status(400).json({ error: 'Invalid contractTemplateId' });
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Load current employment record (lock it)
    const { rows: currentRows } = await client.query<{
      id: number; site_id: number; job_role_id: number | null;
      team_id: number | null; supervisor_id: number | null; started_on: string;
    }>(
      `SELECT id, site_id, job_role_id, team_id, supervisor_id, started_on
       FROM employment_records
       WHERE employee_id = $1 AND ended_on IS NULL
       FOR UPDATE`,
      [employeeId],
    );

    const current = currentRows[0] ?? null;

    if (current) {
      // Validate: effectiveDate must be after current record's started_on
      const { rows: checkRows } = await client.query<{ valid: boolean }>(
        `SELECT ($1::date > $2::date) AS valid`,
        [effectiveDate, current.started_on],
      );
      if (!checkRows[0].valid) {
        await client.query('ROLLBACK');
        res.status(400).json({
          error: `Effective date must be after the current record's start date (${current.started_on})`,
        });
        return;
      }

      // End the current record: ended_on = effectiveDate - 1 day
      await client.query(
        `UPDATE employment_records
         SET ended_on = $1::date - INTERVAL '1 day'
         WHERE id = $2`,
        [effectiveDate, current.id],
      );
    }

    // Insert new employment record with new contract, same other fields
    const { rows: newRows } = await client.query<{ id: number }>(
      `INSERT INTO employment_records
         (employee_id, site_id, job_role_id, contract_template_id, team_id, supervisor_id, started_on, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        employeeId,
        current?.site_id ?? null,
        current?.job_role_id ?? null,
        contractTemplateId,
        current?.team_id ?? null,
        current?.supervisor_id ?? null,
        effectiveDate,
        notes || 'Contract Change',
      ],
    );

    await client.query('COMMIT');
    res.status(201).json({ id: newRows[0].id, effectiveDate });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/employees/:id/change-contract', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});
