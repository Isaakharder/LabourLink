import { pool } from "../db";

export type RecipientMode = "all" | "selected";

export type ResolveRecipientsResult =
  | { ok: true; employeeIds: string[] }
  | { ok: false; error: string };

// Shared by the desktop send route (routes/messages.ts) and the mobile send
// route (routes/mobileMessages.ts) — "all employees" always means every
// currently-active employee, resolved fresh at send time (never cached,
// never re-derived later — see 027_employee_messages.sql's header comment:
// the resulting recipient rows are a snapshot, so a later deactivation
// can't retroactively change who a past send says it went to). A
// client-supplied "selected" id list is never trusted as-is: it's
// re-validated against the active employee set here, the same way
// employeeBlocks.ts's row-linking endpoint re-validates client-supplied ids.
export async function resolveRecipients(
  recipientMode: RecipientMode,
  employeeIds?: unknown
): Promise<ResolveRecipientsResult> {
  if (recipientMode === "all") {
    const active = await pool.query("select id from employees where is_active = true");
    return { ok: true, employeeIds: active.rows.map((r) => r.id) };
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !Array.isArray(employeeIds) ||
    employeeIds.length === 0 ||
    !employeeIds.every((v) => typeof v === "string" && UUID_RE.test(v))
  ) {
    return { ok: false, error: "employeeIds must be a non-empty array of employee ids" };
  }
  const active = await pool.query(
    "select id from employees where id = any($1::uuid[]) and is_active = true",
    [employeeIds]
  );
  if (active.rows.length !== new Set(employeeIds).size) {
    return { ok: false, error: "One or more selected employees are not active" };
  }
  return { ok: true, employeeIds: active.rows.map((r) => r.id) };
}

export interface CreateEmployeeMessageParams {
  messageText: string;
  createdByEmployeeId: string;
  recipientMode: RecipientMode;
  // Already resolved/validated via resolveRecipients — this function never
  // re-derives or re-validates the list itself.
  employeeIds: string[];
  // Client-generated UUID (mobile only — desktop's send form has no retry
  // path that could double-submit the same logical send, so it never
  // supplies one). See 042_message_idempotency.sql: a replayed call with
  // the same key is a true no-op on the insert, exactly like
  // time_entries.idempotency_key.
  idempotencyKey?: string | null;
}

export interface CreateEmployeeMessageResult {
  messageId: string;
  // false when idempotencyKey matched an existing message — the caller
  // already committed on a prior attempt, this call just resolved to that
  // same row rather than creating a duplicate.
  created: boolean;
}

// The one place `employee_messages`/`employee_message_recipients` rows get
// written — both routes/messages.ts (desktop) and routes/mobileMessages.ts
// (mobile) call this rather than each doing their own insert, so "reuse the
// existing stored-message... system" is literally true at the code level,
// not just conceptually.
export async function createEmployeeMessage(
  params: CreateEmployeeMessageParams
): Promise<CreateEmployeeMessageResult> {
  const { messageText, createdByEmployeeId, recipientMode, employeeIds, idempotencyKey } = params;

  const client = await pool.connect();
  try {
    await client.query("begin");

    let messageId: string;
    let created = true;

    if (idempotencyKey) {
      const insert = await client.query(
        `insert into employee_messages (message_text, created_by_employee_id, all_employees, idempotency_key)
         values ($1, $2, $3, $4)
         on conflict (idempotency_key) do nothing
         returning id`,
        [messageText, createdByEmployeeId, recipientMode === "all", idempotencyKey]
      );
      if (insert.rows[0]) {
        messageId = insert.rows[0].id;
      } else {
        // Replay of an already-succeeded send — the recipient rows from the
        // original attempt already exist too (same transaction originally),
        // so there's nothing left to insert; just report the existing id.
        const existing = await client.query(
          `select id from employee_messages where idempotency_key = $1`,
          [idempotencyKey]
        );
        messageId = existing.rows[0].id;
        created = false;
      }
    } else {
      const insert = await client.query(
        `insert into employee_messages (message_text, created_by_employee_id, all_employees)
         values ($1, $2, $3) returning id`,
        [messageText, createdByEmployeeId, recipientMode === "all"]
      );
      messageId = insert.rows[0].id;
    }

    if (created) {
      await client.query(
        `insert into employee_message_recipients (message_id, employee_id)
         select $1, unnest($2::uuid[])`,
        [messageId, employeeIds]
      );
    }

    await client.query("commit");
    return { messageId, created };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
