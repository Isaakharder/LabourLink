import { randomUUID } from "crypto";
import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAuth, requireRole } from "../middleware/auth";
import { normalizePhoneNumber } from "../lib/phone";
import { deleteEmployeePhoto, getSignedPhotoUrl, getSignedPhotoUrls, uploadEmployeePhoto } from "../lib/storage";
import { addEmployeeToActivityGroup, removeEmployeeFromActivityGroup } from "../lib/activityGroupAssignment";
import {
  DEFAULT_WORK_PERMIT_LEAD_MONTHS,
  MAX_WORK_PERMIT_LEAD_DAYS,
  MIN_WORK_PERMIT_LEAD_DAYS,
  isValidWorkPermitLeadDays,
  isValidWorkPermitLeadMonths,
  recordWorkPermitHistory,
} from "../lib/workPermits";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const NATIONALITIES = ["Canadian", "Mexican", "Jamaican", "Guatemalan", "Filipino", "Thai"] as const;
const GENDERS = ["Male", "Female", "Prefer not to say"] as const;
const LANGUAGES = ["English", "Spanish"] as const;

type Nationality = (typeof NATIONALITIES)[number];

// -- shared field helpers ---------------------------------------------------

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isValidDate(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v));
}

function duplicateFieldFromConstraint(constraint?: string): string | null {
  // Both the original plain-column unique index and the later
  // case/whitespace-insensitive functional index guard email uniqueness —
  // either one can be the constraint Postgres reports.
  if (constraint === "employees_email_key" || constraint === "employees_email_normalized_key") {
    return "email";
  }
  if (constraint === "employees_employee_number_key") return "employeeNumber";
  return null;
}

interface EmployeeFields {
  firstName: string;
  lastName: string;
  gender: string | null;
  dateOfBirth: string | null;
  email: string | null;
  phoneNumber: string | null;
  jobGroup: string | null;
  startDate: string;
  isActive: boolean;
  employeeNumber: string | null;
  nationality: Nationality;
  preferredLanguage: string | null;
  notes: string | null;
  securityRoleId: number | null;
  teamRoleId: number | null;
  breakProfileId: string | null;
}

// Validates a full create payload — every required field must be present.
function validateCreate(body: Record<string, unknown>):
  | { errors: Record<string, string> }
  | { data: EmployeeFields } {
  const errors: Record<string, string> = {};

  const firstName = trimOrNull(body.firstName);
  if (!firstName) errors.firstName = "First name is required";

  const lastName = trimOrNull(body.lastName);
  if (!lastName) errors.lastName = "Last name is required";

  if (!isValidDate(body.startDate)) errors.startDate = "A valid start date is required";

  const nationality = body.nationality as Nationality;
  if (!NATIONALITIES.includes(nationality)) {
    errors.nationality = `Nationality must be one of: ${NATIONALITIES.join(", ")}`;
  }

  let email: string | null = null;
  const rawEmail = trimOrNull(body.email as string);
  if (rawEmail) {
    email = rawEmail.toLowerCase();
    if (!EMAIL_RE.test(email)) errors.email = "Email address is not valid";
  }

  let gender: string | null = null;
  const rawGender = trimOrNull(body.gender as string);
  if (rawGender) {
    if (!(GENDERS as readonly string[]).includes(rawGender)) {
      errors.gender = "Gender must be one of the supported options";
    } else {
      gender = rawGender;
    }
  }

  let preferredLanguage: string | null = null;
  const rawLanguage = trimOrNull(body.preferredLanguage as string);
  if (rawLanguage) {
    if (!(LANGUAGES as readonly string[]).includes(rawLanguage)) {
      errors.preferredLanguage = "Preferred language must be English or Spanish";
    } else {
      preferredLanguage = rawLanguage;
    }
  }

  let dateOfBirth: string | null = null;
  if (body.dateOfBirth != null && String(body.dateOfBirth).trim() !== "") {
    if (!isValidDate(body.dateOfBirth)) {
      errors.dateOfBirth = "Date of birth is not a valid date";
    } else {
      dateOfBirth = body.dateOfBirth as string;
    }
  }

  let phoneNumber: string | null = null;
  const rawPhone = trimOrNull(body.phoneNumber as string);
  if (rawPhone) {
    phoneNumber = normalizePhoneNumber(rawPhone, NATIONALITIES.includes(nationality) ? nationality : null);
  }

  const securityRoleId = body.securityRoleId != null ? Number(body.securityRoleId) : null;
  const teamRoleId = body.teamRoleId != null ? Number(body.teamRoleId) : null;
  if (body.securityRoleId != null && !Number.isInteger(securityRoleId)) {
    errors.securityRoleId = "Invalid security role";
  }
  if (body.teamRoleId != null && !Number.isInteger(teamRoleId)) {
    errors.teamRoleId = "Invalid team role";
  }

  let breakProfileId: string | null = null;
  if (body.breakProfileId != null && String(body.breakProfileId).trim() !== "") {
    const v = String(body.breakProfileId);
    if (!UUID_RE.test(v)) errors.breakProfileId = "Invalid break profile";
    else breakProfileId = v;
  }

  if (Object.keys(errors).length) return { errors };

  return {
    data: {
      firstName: firstName!,
      lastName: lastName!,
      gender,
      dateOfBirth,
      email,
      phoneNumber,
      jobGroup: trimOrNull(body.jobGroup as string),
      startDate: body.startDate as string,
      isActive: body.isActive === undefined ? true : Boolean(body.isActive),
      employeeNumber: trimOrNull(body.employeeNumber as string),
      nationality,
      preferredLanguage,
      notes: trimOrNull(body.notes as string),
      securityRoleId,
      teamRoleId,
      breakProfileId,
    },
  };
}

// Validates a partial update payload — only keys actually present in the
// body are checked/applied; anything absent is left untouched.
function validateUpdate(body: Record<string, unknown>):
  | { errors: Record<string, string> }
  | { data: Partial<EmployeeFields> } {
  const errors: Record<string, string> = {};
  const data: Partial<EmployeeFields> = {};

  if ("firstName" in body) {
    const v = trimOrNull(body.firstName as string);
    if (!v) errors.firstName = "First name is required";
    else data.firstName = v;
  }
  if ("lastName" in body) {
    const v = trimOrNull(body.lastName as string);
    if (!v) errors.lastName = "Last name is required";
    else data.lastName = v;
  }
  if ("startDate" in body) {
    if (!isValidDate(body.startDate)) errors.startDate = "A valid start date is required";
    else data.startDate = body.startDate as string;
  }

  let nationalityForPhone: Nationality | null = null;
  if ("nationality" in body) {
    const nationality = body.nationality as Nationality;
    if (!NATIONALITIES.includes(nationality)) {
      errors.nationality = `Nationality must be one of: ${NATIONALITIES.join(", ")}`;
    } else {
      data.nationality = nationality;
      nationalityForPhone = nationality;
    }
  }

  if ("email" in body) {
    const rawEmail = trimOrNull(body.email as string);
    if (!rawEmail) {
      data.email = null;
    } else {
      const email = rawEmail.toLowerCase();
      if (!EMAIL_RE.test(email)) errors.email = "Email address is not valid";
      else data.email = email;
    }
  }

  if ("gender" in body) {
    const rawGender = trimOrNull(body.gender as string);
    if (!rawGender) data.gender = null;
    else if (!(GENDERS as readonly string[]).includes(rawGender)) {
      errors.gender = "Gender must be one of the supported options";
    } else {
      data.gender = rawGender;
    }
  }

  if ("preferredLanguage" in body) {
    const rawLanguage = trimOrNull(body.preferredLanguage as string);
    if (!rawLanguage) data.preferredLanguage = null;
    else if (!(LANGUAGES as readonly string[]).includes(rawLanguage)) {
      errors.preferredLanguage = "Preferred language must be English or Spanish";
    } else {
      data.preferredLanguage = rawLanguage;
    }
  }

  if ("dateOfBirth" in body) {
    const raw = body.dateOfBirth;
    if (raw == null || String(raw).trim() === "") {
      data.dateOfBirth = null;
    } else if (!isValidDate(raw)) {
      errors.dateOfBirth = "Date of birth is not a valid date";
    } else {
      data.dateOfBirth = raw as string;
    }
  }

  if ("phoneNumber" in body) {
    const rawPhone = trimOrNull(body.phoneNumber as string);
    data.phoneNumber = rawPhone ? normalizePhoneNumber(rawPhone, nationalityForPhone) : null;
  }

  if ("jobGroup" in body) data.jobGroup = trimOrNull(body.jobGroup as string);
  if ("employeeNumber" in body) data.employeeNumber = trimOrNull(body.employeeNumber as string);
  if ("notes" in body) data.notes = trimOrNull(body.notes as string);
  if ("isActive" in body) data.isActive = Boolean(body.isActive);

  if ("securityRoleId" in body) {
    const n = Number(body.securityRoleId);
    if (!Number.isInteger(n)) errors.securityRoleId = "Invalid security role";
    else data.securityRoleId = n;
  }
  if ("teamRoleId" in body) {
    const n = Number(body.teamRoleId);
    if (!Number.isInteger(n)) errors.teamRoleId = "Invalid team role";
    else data.teamRoleId = n;
  }

  if ("breakProfileId" in body) {
    const raw = body.breakProfileId;
    if (raw == null || String(raw).trim() === "") {
      data.breakProfileId = null;
    } else if (!UUID_RE.test(String(raw))) {
      errors.breakProfileId = "Invalid break profile";
    } else {
      data.breakProfileId = String(raw);
    }
  }

  if (Object.keys(errors).length) return { errors };
  return { data };
}

// -- work permit fields -------------------------------------------------
//
// Deliberately kept separate from EmployeeFields/columnMap above — unlike
// every other field, these three have real cross-field behavior (a
// changed expiry date must write an audit history row; the notify lead
// must default server-side when an expiry is entered with none; clearing
// the expiry must also clear the lead settings, per
// chk_employees_work_permit_lead_set_with_expiry) that a generic
// "whatever keys are present become SET clauses" loop can't express.

interface WorkPermitPatch {
  // Absent = "not touched by this request." Present-and-null = "clear it."
  expiryDate?: string | null;
  leadMonths?: number | null;
  leadDays?: number | null;
}

// Shape-only validation (is this a valid date / one of the allowed month
// presets / a sensible day count, and not both a preset AND custom days at
// once) — independent of any existing row, so usable by both create
// (no prior row) and update.
function parseWorkPermitFields(body: Record<string, unknown>): { errors: Record<string, string> } | { data: WorkPermitPatch } {
  const errors: Record<string, string> = {};
  const data: WorkPermitPatch = {};

  if ("workPermitExpiryDate" in body) {
    const raw = body.workPermitExpiryDate;
    if (raw == null || String(raw).trim() === "") {
      data.expiryDate = null;
    } else if (!isValidDate(raw)) {
      errors.workPermitExpiryDate = "Work permit expiry date is not a valid date";
    } else {
      data.expiryDate = raw as string;
    }
  }
  if ("workPermitNotifyLeadMonths" in body) {
    const raw = body.workPermitNotifyLeadMonths;
    if (raw == null || raw === "") {
      data.leadMonths = null;
    } else {
      const n = Number(raw);
      if (!isValidWorkPermitLeadMonths(n)) errors.workPermitNotifyLeadMonths = "Lead time must be 1, 2, 3, 6, or 12 months";
      else data.leadMonths = n;
    }
  }
  if ("workPermitNotifyLeadDays" in body) {
    const raw = body.workPermitNotifyLeadDays;
    if (raw == null || raw === "") {
      data.leadDays = null;
    } else {
      const n = Number(raw);
      if (!isValidWorkPermitLeadDays(n)) {
        errors.workPermitNotifyLeadDays = `Custom lead time must be a whole number of days between ${MIN_WORK_PERMIT_LEAD_DAYS} and ${MAX_WORK_PERMIT_LEAD_DAYS}`;
      } else {
        data.leadDays = n;
      }
    }
  }
  if (data.leadMonths != null && data.leadDays != null) {
    errors.workPermitNotifyLeadDays = "Choose either a preset lead time or a custom number of days, not both";
  }

  if (Object.keys(errors).length) return { errors };
  return { data };
}

interface CurrentWorkPermit {
  expiryDate: string | null;
  leadMonths: number | null;
  leadDays: number | null;
}

// Resolves a shape-validated WorkPermitPatch (parseWorkPermitFields above)
// against whatever the row currently has (null current = a brand-new
// employee being created) into the actual columns to write plus, if the
// expiry date is actually changing, the history row to record — every
// caller (create and update) shares this exact resolution so "the server
// defaults to 6 months" and "every expiry change gets history" can never
// drift between the two entry points.
function resolveWorkPermitUpdate(
  patch: WorkPermitPatch,
  current: CurrentWorkPermit | null
): { errors: Record<string, string> } | { columns: Record<string, unknown>; historyWrite: { old: string | null; new: string | null } | null } {
  const columns: Record<string, unknown> = {};
  let historyWrite: { old: string | null; new: string | null } | null = null;

  const touchesExpiry = "expiryDate" in patch;
  const touchesLead = "leadMonths" in patch || "leadDays" in patch;
  const currentExpiry = current?.expiryDate ?? null;

  if (touchesExpiry) {
    const newExpiry = patch.expiryDate ?? null;
    columns.work_permit_expiry_date = newExpiry;
    if (newExpiry !== currentExpiry) {
      historyWrite = { old: currentExpiry, new: newExpiry };
    }

    if (newExpiry === null) {
      // Clearing the (optional) expiry date stops alerts and clears the
      // now-meaningless lead settings alongside it — required by
      // chk_employees_work_permit_lead_set_with_expiry regardless.
      columns.work_permit_notify_lead_months = null;
      columns.work_permit_notify_lead_days = null;
    } else if (touchesLead && (patch.leadMonths != null || patch.leadDays != null)) {
      columns.work_permit_notify_lead_months = patch.leadMonths ?? null;
      columns.work_permit_notify_lead_days = patch.leadDays ?? null;
    } else if (currentExpiry == null) {
      // First time an expiry is ever being set on this employee, with no
      // explicit lead in this same request — server-side default.
      columns.work_permit_notify_lead_months = DEFAULT_WORK_PERMIT_LEAD_MONTHS;
      columns.work_permit_notify_lead_days = null;
    }
    // else: an already-tracked permit's date is being corrected and lead
    // wasn't touched — leave the existing lead columns alone entirely
    // (not included in `columns`), preserving whatever was already set.
  } else if (touchesLead) {
    // Changing only the lead preference, expiry date untouched.
    if (patch.leadMonths == null && patch.leadDays == null) {
      if (currentExpiry != null) {
        return { errors: { workPermitNotifyLeadDays: "A lead time is required while a work permit expiry date is set" } };
      }
      // No expiry either way — nothing meaningful to store.
    } else {
      columns.work_permit_notify_lead_months = patch.leadMonths ?? null;
      columns.work_permit_notify_lead_days = patch.leadDays ?? null;
    }
  }

  return { columns, historyWrite };
}

// -- shared query pieces -----------------------------------------------------

// settings_pin_hash is deliberately never selected — not just omitted at
// serialization time, so a bug there can't leak it either.
// date/date_of_birth are explicitly formatted as plain YYYY-MM-DD text —
// otherwise pg returns them as full midnight-UTC timestamps, which
// <input type="date"> on the edit form can't parse back into itself.
const SELECT_COLUMNS = `
  e.id, e.first_name, e.last_name, e.gender,
  to_char(e.date_of_birth, 'YYYY-MM-DD') as date_of_birth,
  e.email, e.phone_number, e.job_group,
  to_char(e.start_date, 'YYYY-MM-DD') as start_date,
  e.is_active, e.employee_number, e.nationality,
  e.preferred_language, e.notes, e.profile_photo_path, e.security_role_id, e.team_role_id,
  e.break_profile_id, bp.name as break_profile_name, bp.is_active as break_profile_is_active,
  to_char(e.work_permit_expiry_date, 'YYYY-MM-DD') as work_permit_expiry_date,
  e.work_permit_notify_lead_months, e.work_permit_notify_lead_days,
  e.created_at, e.updated_at,
  sr.name as security_role, tr.name as team_role,
  dev.device_id, dev.device_name,
  coalesce(agg.groups, '[]'::json) as activity_groups
`;

const FROM_JOINS = `
  from employees e
  join security_roles sr on sr.id = e.security_role_id
  join team_roles tr on tr.id = e.team_role_id
  left join break_profiles bp on bp.id = e.break_profile_id
  left join lateral (
    select da.device_id, d.device_name
    from device_assignments da
    join devices d on d.id = da.device_id
    where da.employee_id = e.id and da.unassigned_at is null
    order by da.assigned_at desc
    limit 1
  ) dev on true
  left join lateral (
    select json_agg(json_build_object('id', ag.id, 'name', ag.name) order by ag.name) as groups
    from employee_activity_group_assignments eaga
    join activity_groups ag on ag.id = eaga.activity_group_id
    where eaga.employee_id = e.id and eaga.unassigned_at is null
  ) agg on true
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeEmployee(row: any, photoUrl: string | null, includeNotes: boolean) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    gender: row.gender,
    dateOfBirth: row.date_of_birth,
    email: row.email,
    phoneNumber: row.phone_number,
    jobGroup: row.job_group,
    startDate: row.start_date,
    isActive: row.is_active,
    employeeNumber: row.employee_number,
    nationality: row.nationality,
    preferredLanguage: row.preferred_language,
    ...(includeNotes ? { notes: row.notes } : {}),
    photoUrl,
    securityRoleId: row.security_role_id,
    securityRole: row.security_role,
    teamRoleId: row.team_role_id,
    teamRole: row.team_role,
    breakProfileId: row.break_profile_id,
    breakProfile: row.break_profile_id
      ? { id: row.break_profile_id, name: row.break_profile_name, isActive: row.break_profile_is_active }
      : null,
    device: row.device_id ? { id: row.device_id, name: row.device_name } : null,
    activityGroups: row.activity_groups,
    // Viewing is already Administrator/Manager-only on every route this
    // serializer feeds (see the requireRole gates on GET / and GET /:id) —
    // the same restriction the brief asks permit fields to share, so no
    // separate includePermit flag is needed the way includeNotes has one.
    workPermitExpiryDate: row.work_permit_expiry_date,
    workPermitNotifyLeadMonths: row.work_permit_notify_lead_months,
    workPermitNotifyLeadDays: row.work_permit_notify_lead_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("UNSUPPORTED_TYPE"));
    }
  },
});

// -- routes -------------------------------------------------------------

router.get(
  "/",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const search = trimOrNull(req.query.search as string);
    const status = (req.query.status as string) || "all";
    const nationality = req.query.nationality as string | undefined;
    const jobGroup = trimOrNull(req.query.jobGroup as string);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status === "active") conditions.push("e.is_active = true");
    else if (status === "inactive") conditions.push("e.is_active = false");

    if (nationality && (NATIONALITIES as readonly string[]).includes(nationality)) {
      params.push(nationality);
      conditions.push(`e.nationality = $${params.length}`);
    }

    if (jobGroup) {
      params.push(jobGroup);
      conditions.push(`e.job_group = $${params.length}`);
    }

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const p = `$${params.length}`;
      conditions.push(
        `(lower(e.first_name || ' ' || e.last_name) like ${p} or lower(coalesce(e.employee_number, '')) like ${p} or lower(coalesce(e.email, '')) like ${p})`
      );
    }

    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const { rows } = await pool.query(
      `select ${SELECT_COLUMNS} ${FROM_JOINS} ${where} order by e.first_name, e.last_name`,
      params
    );

    const photoPaths = rows.filter((r) => r.profile_photo_path).map((r) => r.profile_photo_path);
    const urlMap = await getSignedPhotoUrls(photoPaths);

    const { rows: jobGroupRows } = await pool.query(
      "select distinct job_group from employees where job_group is not null order by job_group"
    );

    res.json({
      employees: rows.map((r) =>
        serializeEmployee(r, r.profile_photo_path ? urlMap.get(r.profile_photo_path) ?? null : null, false)
      ),
      jobGroups: jobGroupRows.map((r) => r.job_group),
    });
  })
);

router.get(
  "/:id",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const { rows } = await pool.query(
      `select ${SELECT_COLUMNS} ${FROM_JOINS} where e.id = $1`,
      [id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Employee not found" });

    const photoUrl = row.profile_photo_path ? await getSignedPhotoUrl(row.profile_photo_path) : null;
    res.json({ employee: serializeEmployee(row, photoUrl, true) });
  })
);

router.post(
  "/",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const result = validateCreate(req.body ?? {});
    if ("errors" in result) return res.status(400).json({ errors: result.errors });
    const d = result.data;

    const permitParse = parseWorkPermitFields(req.body ?? {});
    if ("errors" in permitParse) return res.status(400).json({ errors: permitParse.errors });
    // A brand-new employee has no prior row — resolveWorkPermitUpdate's
    // "first time being set" branch is what supplies the 6-month default
    // here too, the exact same resolution PATCH uses.
    const permitResolved = resolveWorkPermitUpdate(permitParse.data, null);
    if ("errors" in permitResolved) return res.status(400).json({ errors: permitResolved.errors });
    const permitExpiryDate = (permitResolved.columns.work_permit_expiry_date as string | null | undefined) ?? null;
    const permitLeadMonths = (permitResolved.columns.work_permit_notify_lead_months as number | null | undefined) ?? null;
    const permitLeadDays = (permitResolved.columns.work_permit_notify_lead_days as number | null | undefined) ?? null;

    if (d.breakProfileId) {
      const profileCheck = await pool.query("select is_active from break_profiles where id = $1", [
        d.breakProfileId,
      ]);
      if (!profileCheck.rows[0] || !profileCheck.rows[0].is_active) {
        return res.status(400).json({ errors: { breakProfileId: "Break profile is not active" } });
      }
    }

    try {
      const { rows } = await pool.query(
        `insert into employees
           (first_name, last_name, gender, date_of_birth, email, phone_number, job_group,
            start_date, is_active, employee_number, nationality, preferred_language, notes,
            security_role_id, team_role_id, settings_pin_hash, break_profile_id,
            work_permit_expiry_date, work_permit_notify_lead_months, work_permit_notify_lead_days)
         values
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            coalesce($14, (select id from security_roles where name = 'Employee')),
            coalesce($15, (select id from team_roles where name = 'Team Member')),
            null, $16, $17, $18, $19)
         returning id`,
        [
          d.firstName,
          d.lastName,
          d.gender,
          d.dateOfBirth,
          d.email,
          d.phoneNumber,
          d.jobGroup,
          d.startDate,
          d.isActive,
          d.employeeNumber,
          d.nationality,
          d.preferredLanguage,
          d.notes,
          d.securityRoleId,
          d.teamRoleId,
          d.breakProfileId,
          permitExpiryDate,
          permitLeadMonths,
          permitLeadDays,
        ]
      );

      if (permitExpiryDate) {
        await recordWorkPermitHistory(pool, rows[0].id, null, permitExpiryDate, req.employee!.id, null);
      }

      const { rows: full } = await pool.query(
        `select ${SELECT_COLUMNS} ${FROM_JOINS} where e.id = $1`,
        [rows[0].id]
      );
      res.status(201).json({ employee: serializeEmployee(full[0], null, true) });
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505") {
        const field = duplicateFieldFromConstraint(pgErr.constraint);
        if (field === "email") {
          return res.status(409).json({ errors: { email: "An employee with this email already exists" } });
        }
        if (field === "employeeNumber") {
          return res
            .status(409)
            .json({ errors: { employeeNumber: "An employee with this employee number already exists" } });
        }
        return res.status(409).json({ error: "Duplicate value" });
      }
      throw err;
    }
  })
);

router.patch(
  "/:id",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const result = validateUpdate(req.body ?? {});
    if ("errors" in result) return res.status(400).json({ errors: result.errors });
    const d = result.data;

    const permitParse = parseWorkPermitFields(req.body ?? {});
    if ("errors" in permitParse) return res.status(400).json({ errors: permitParse.errors });
    const touchesWorkPermit = Object.keys(permitParse.data).length > 0;

    // A *new* break profile assignment (different from what's already
    // stored) must reference an active profile — leaving the value
    // unchanged is always allowed even if that profile has since gone
    // inactive, which is what keeps history visible without permitting a
    // fresh assignment to a retired profile.
    if ("breakProfileId" in d) {
      const current = await pool.query("select break_profile_id from employees where id = $1", [id]);
      if (!current.rows[0]) return res.status(404).json({ error: "Employee not found" });
      const currentBreakProfileId: string | null = current.rows[0].break_profile_id;
      if (d.breakProfileId !== null && d.breakProfileId !== currentBreakProfileId) {
        const profileCheck = await pool.query("select is_active from break_profiles where id = $1", [
          d.breakProfileId,
        ]);
        if (!profileCheck.rows[0] || !profileCheck.rows[0].is_active) {
          return res.status(400).json({ errors: { breakProfileId: "Break profile is not active" } });
        }
      }
    }

    // Resolved against the CURRENT row (needed for the server-side 6-month
    // default, and to know whether the expiry date is actually changing —
    // only a real change gets a history row) — see resolveWorkPermitUpdate's
    // own comment for why this can't be a generic columnMap entry.
    let permitColumns: Record<string, unknown> = {};
    let permitHistoryWrite: { old: string | null; new: string | null } | null = null;
    if (touchesWorkPermit) {
      const currentRes = await pool.query(
        `select to_char(work_permit_expiry_date, 'YYYY-MM-DD') as expiry_date,
                work_permit_notify_lead_months, work_permit_notify_lead_days
         from employees where id = $1`,
        [id]
      );
      if (!currentRes.rows[0]) return res.status(404).json({ error: "Employee not found" });
      const current = {
        expiryDate: currentRes.rows[0].expiry_date as string | null,
        leadMonths: currentRes.rows[0].work_permit_notify_lead_months as number | null,
        leadDays: currentRes.rows[0].work_permit_notify_lead_days as number | null,
      };
      const resolved = resolveWorkPermitUpdate(permitParse.data, current);
      if ("errors" in resolved) return res.status(400).json({ errors: resolved.errors });
      permitColumns = resolved.columns;
      permitHistoryWrite = resolved.historyWrite;
    }

    const columnMap: Record<keyof EmployeeFields, string> = {
      firstName: "first_name",
      lastName: "last_name",
      gender: "gender",
      dateOfBirth: "date_of_birth",
      email: "email",
      phoneNumber: "phone_number",
      jobGroup: "job_group",
      startDate: "start_date",
      isActive: "is_active",
      employeeNumber: "employee_number",
      nationality: "nationality",
      preferredLanguage: "preferred_language",
      notes: "notes",
      securityRoleId: "security_role_id",
      teamRoleId: "team_role_id",
      breakProfileId: "break_profile_id",
    };

    const keys = Object.keys(d) as (keyof EmployeeFields)[];
    const permitColumnNames = Object.keys(permitColumns);
    if (keys.length === 0 && permitColumnNames.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const values: unknown[] = [...keys.map((k) => d[k]), ...permitColumnNames.map((c) => permitColumns[c])];
    const setClauses = [
      ...keys.map((k, i) => `${columnMap[k]} = $${i + 1}`),
      ...permitColumnNames.map((c, i) => `${c} = $${keys.length + i + 1}`),
    ];
    setClauses.push("updated_at = now()");

    const client = await pool.connect();
    try {
      await client.query("begin");

      const { rows } = await client.query(
        `update employees set ${setClauses.join(", ")} where id = $${values.length + 1} returning id`,
        [...values, id]
      );
      if (!rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Employee not found" });
      }

      if (permitHistoryWrite) {
        await recordWorkPermitHistory(client, id, permitHistoryWrite.old, permitHistoryWrite.new, req.employee!.id, null);
      }

      // Deactivating an employee must not leave them reachable through a
      // still-active device assignment. The mobile auth middleware already
      // checks employees.is_active on every request, so this isn't the only
      // thing stopping access — but leaving the assignment "open" is
      // misleading (Setup/Devices would still show the device as assigned to
      // someone inactive) and would silently reactivate on its own if the
      // employee is ever re-activated later. Ending it (not deleting it)
      // keeps assignment history intact and leaves the device itself
      // untouched — it's free to be reassigned to someone else.
      if (d.isActive === false) {
        await client.query(
          `update device_assignments set unassigned_at = now()
           where employee_id = $1 and unassigned_at is null`,
          [id]
        );
        await client.query(
          `update employee_activity_group_assignments set unassigned_at = now()
           where employee_id = $1 and unassigned_at is null`,
          [id]
        );
      }

      await client.query("commit");

      const { rows: full } = await pool.query(
        `select ${SELECT_COLUMNS} ${FROM_JOINS} where e.id = $1`,
        [id]
      );
      const photoUrl = full[0].profile_photo_path
        ? await getSignedPhotoUrl(full[0].profile_photo_path)
        : null;
      res.json({ employee: serializeEmployee(full[0], photoUrl, true) });
    } catch (err) {
      await client.query("rollback");
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505") {
        const field = duplicateFieldFromConstraint(pgErr.constraint);
        if (field === "email") {
          return res.status(409).json({ errors: { email: "An employee with this email already exists" } });
        }
        if (field === "employeeNumber") {
          return res
            .status(409)
            .json({ errors: { employeeNumber: "An employee with this employee number already exists" } });
        }
        return res.status(409).json({ error: "Duplicate value" });
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

router.get(
  "/:id/activity-groups",
  requireAuth,
  requireRole("Administrator", "Manager"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const empCheck = await pool.query("select id from employees where id = $1", [id]);
    if (!empCheck.rows[0]) return res.status(404).json({ error: "Employee not found" });

    const { rows } = await pool.query(
      `select ag.id, ag.name
       from employee_activity_group_assignments eaga
       join activity_groups ag on ag.id = eaga.activity_group_id
       where eaga.employee_id = $1 and eaga.unassigned_at is null
       order by ag.name`,
      [id]
    );
    res.json({ activityGroups: rows });
  })
);

router.put(
  "/:id/activity-groups",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const raw = req.body?.activityGroupIds;
    if (!Array.isArray(raw)) return res.status(400).json({ error: "activityGroupIds must be an array" });
    const desired = [...new Set(raw)];
    if (!desired.every((gid) => typeof gid === "string" && UUID_RE.test(gid))) {
      return res.status(400).json({ error: "One or more activityGroupIds are invalid" });
    }
    if (desired.length) {
      const check = await pool.query(
        "select id from activity_groups where id = any($1::uuid[]) and is_active = true",
        [desired]
      );
      if (check.rows.length !== desired.length) {
        return res.status(400).json({ error: "One or more activityGroupIds do not match an active activity group" });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const empCheck = await client.query("select id from employees where id = $1", [id]);
      if (!empCheck.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Employee not found" });
      }

      const current = await client.query(
        "select activity_group_id from employee_activity_group_assignments where employee_id = $1 and unassigned_at is null",
        [id]
      );
      const currentIds = new Set(current.rows.map((r) => r.activity_group_id as string));
      const desiredSet = new Set(desired as string[]);

      for (const gid of currentIds) {
        if (!desiredSet.has(gid)) await removeEmployeeFromActivityGroup(client, id, gid);
      }
      for (const gid of desiredSet) {
        if (!currentIds.has(gid)) await addEmployeeToActivityGroup(client, id, gid, req.employee!.id);
      }

      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      `select ag.id, ag.name
       from employee_activity_group_assignments eaga
       join activity_groups ag on ag.id = eaga.activity_group_id
       where eaga.employee_id = $1 and eaga.unassigned_at is null
       order by ag.name`,
      [id]
    );
    res.json({ activityGroups: rows });
  })
);

router.post(
  "/:id/photo",
  requireAuth,
  requireRole("Administrator"),
  (req, res, next) => {
    upload.single("photo")(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          error: err.message === "UNSUPPORTED_TYPE" ? "Only JPEG, PNG, or WebP images are allowed" : "Upload failed",
        });
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "photo file is required" });

    const existing = await pool.query("select profile_photo_path from employees where id = $1", [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: "Employee not found" });
    const oldPath: string | null = existing.rows[0].profile_photo_path;

    // Re-encode regardless of input format: crops to a centered square and
    // converts to webp, and (as a side effect) sharp will reject anything
    // that isn't actually a decodable image even if the MIME type claimed
    // otherwise.
    let processed: Buffer;
    try {
      processed = await sharp(file.buffer)
        .resize(512, 512, { fit: "cover", position: "attention" })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      return res.status(400).json({ error: "Could not process image file" });
    }

    const newPath = await uploadEmployeePhoto(id, randomUUID(), processed, "image/webp");

    await pool.query("update employees set profile_photo_path = $1, updated_at = now() where id = $2", [
      newPath,
      id,
    ]);

    if (oldPath && oldPath !== newPath) {
      await deleteEmployeePhoto(oldPath);
    }

    const photoUrl = await getSignedPhotoUrl(newPath);
    res.json({ photoUrl });
  })
);

router.delete(
  "/:id/photo",
  requireAuth,
  requireRole("Administrator"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid employee id" });

    const existing = await pool.query("select profile_photo_path from employees where id = $1", [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: "Employee not found" });
    const oldPath: string | null = existing.rows[0].profile_photo_path;

    await pool.query("update employees set profile_photo_path = null, updated_at = now() where id = $1", [
      id,
    ]);
    if (oldPath) await deleteEmployeePhoto(oldPath);

    res.status(204).send();
  })
);

export default router;
