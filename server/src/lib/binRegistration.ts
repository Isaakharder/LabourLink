// Register Bins at the weighing station: an empty bin on the scale gives its
// RFID tag and its tare (the stable gross weight of the empty bin), which are
// written to that bin's EXISTING carrier record. Never creates a carrier and
// never creates a weighing.
//
// Every rule the station enforces is enforced here again, because the
// carrier record is what every future weighing's net weight depends on:
//   - the bin must exist and be active;
//   - the measurement must be a stable gross reading of at least
//     MIN_REGISTRATION_KG, and the person must have confirmed the bin is empty;
//   - one tag, one bin: a tag already on another bin is refused unless the
//     request explicitly moves it from that bin (a correction);
//   - replacing an existing tag or tare needs explicit confirmation;
//   - the person must have seen the bin's current tag and tare (`expected`),
//     so two people registering at once can't silently overwrite each other;
//   - a repeated request (same registrationId) is applied once.
// Every change writes carrier_registration_audit rows in the same transaction.
import { PoolClient } from "pg";
import { pool } from "../db";
import { parseRfidTag } from "./rfidTag";

export const MIN_REGISTRATION_KG = 2;
export const MAX_TARE_KG = 999.99;
// The station's own stability rule is stricter (scale config
// stableToleranceKg); this only rejects a reading that clearly wasn't stable.
export const MAX_SAMPLE_SPREAD_KG = 0.2;
export const MIN_STABLE_MS = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function roundKg(kg: number): number {
  return Math.round(kg * 100) / 100;
}

export interface CarrierSummary {
  id: string;
  name: string;
  rfidTag: string | null;
  tareWeightKg: number;
  isActive: boolean;
}

export function summarize(row: { id: string; name: string; rfid_tag: string | null; tare_weight_kg: string | number; is_active: boolean }): CarrierSummary {
  return { id: row.id, name: row.name, rfidTag: row.rfid_tag ?? null, tareWeightKg: Number(row.tare_weight_kg), isActive: row.is_active };
}

export interface RegistrationInput {
  registrationId: string;
  carrierId: string;
  rfidTag: string;
  tareKg: number;
  measured: { grossKg: number; samplesKg: number[]; status: "gross"; stableMs: number };
  expected: { rfidTag: string | null; tareWeightKg: number };
  emptyConfirmed: true;
  confirmOverwrite: boolean;
  moveFromCarrierId: string | null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

function isKg(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseExpected(v: unknown, errors: Record<string, string>): { rfidTag: string | null; tareWeightKg: number } | null {
  const e = (v ?? null) as { rfidTag?: unknown; tareWeightKg?: unknown } | null;
  if (!e || typeof e !== "object") {
    errors.expected = "the bin's current tag and tare, as shown to the person, are required";
    return null;
  }
  const tag = parseRfidTag(e.rfidTag);
  if (!tag.ok || !isKg(e.tareWeightKg)) {
    errors.expected = "the bin's current tag and tare, as shown to the person, are required";
    return null;
  }
  return { rfidTag: tag.value, tareWeightKg: roundKg(e.tareWeightKg) };
}

export function parseRegistration(body: unknown): Parsed<RegistrationInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  if (typeof b.registrationId !== "string" || !UUID_RE.test(b.registrationId)) errors.registrationId = "must be a UUID";
  if (typeof b.carrierId !== "string" || !UUID_RE.test(b.carrierId)) errors.carrierId = "choose a bin";
  const tag = parseRfidTag(b.rfidTag);
  if (!tag.ok || tag.value === null) errors.rfidTag = "No RFID tag was read. Every bin needs its tag.";

  const m = (b.measured ?? {}) as Record<string, unknown>;
  const samples = Array.isArray(m.samplesKg) ? (m.samplesKg as unknown[]) : null;
  if (!isKg(m.grossKg) || m.grossKg < MIN_REGISTRATION_KG) {
    errors.measured = `The scale must read at least ${MIN_REGISTRATION_KG} kg with the empty bin on it.`;
  } else if (m.grossKg > MAX_TARE_KG) {
    errors.measured = `A tare above ${MAX_TARE_KG} kg can't be stored.`;
  } else if (m.status !== "gross") {
    errors.measured = "The indicator must be in gross mode.";
  } else if (!samples || samples.length < 5 || samples.length > 500 || !samples.every(isKg)) {
    errors.measured = "The stable readings are missing.";
  } else if (Math.max(...(samples as number[])) - Math.min(...(samples as number[])) > MAX_SAMPLE_SPREAD_KG) {
    errors.measured = "The weight was not stable.";
  } else if (typeof m.stableMs !== "number" || m.stableMs < MIN_STABLE_MS) {
    errors.measured = "The weight was not stable for long enough.";
  }
  if (!errors.measured && (!isKg(b.tareKg) || roundKg(b.tareKg) !== roundKg(m.grossKg as number))) {
    errors.tareKg = "The tare must be the measured gross weight of the empty bin.";
  }
  if (b.emptyConfirmed !== true) errors.emptyConfirmed = "Confirm that the bin is completely empty.";
  const expected = parseExpected(b.expected, errors);
  const moveFrom = b.moveFromCarrierId ?? null;
  if (moveFrom !== null && (typeof moveFrom !== "string" || !UUID_RE.test(moveFrom))) errors.moveFromCarrierId = "must be a bin id";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      registrationId: (b.registrationId as string).toLowerCase(),
      carrierId: (b.carrierId as string).toLowerCase(),
      rfidTag: (tag as { ok: true; value: string }).value,
      tareKg: roundKg(m.grossKg as number),
      measured: {
        grossKg: roundKg(m.grossKg as number),
        samplesKg: samples as number[],
        status: "gross",
        stableMs: Math.round(m.stableMs as number),
      },
      expected: expected!,
      emptyConfirmed: true,
      confirmOverwrite: b.confirmOverwrite === true,
      moveFromCarrierId: moveFrom === null ? null : (moveFrom as string).toLowerCase(),
    },
  };
}

export interface RemoveTagInput {
  registrationId: string;
  carrierId: string;
  expected: { rfidTag: string | null; tareWeightKg: number };
  reason: string | null;
}

export function parseRemoveTag(body: unknown): Parsed<RemoveTagInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  if (typeof b.registrationId !== "string" || !UUID_RE.test(b.registrationId)) errors.registrationId = "must be a UUID";
  if (typeof b.carrierId !== "string" || !UUID_RE.test(b.carrierId)) errors.carrierId = "choose a bin";
  if (b.confirm !== true) errors.confirm = "Confirm removing the tag.";
  const expected = parseExpected(b.expected, errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;
  return {
    ok: true,
    value: { registrationId: (b.registrationId as string).toLowerCase(), carrierId: (b.carrierId as string).toLowerCase(), expected: expected!, reason },
  };
}

export type RegistrationOutcome =
  | { kind: "ok"; status: 200 | 201; body: Record<string, unknown> }
  | { kind: "refused"; status: 404 | 409; body: Record<string, unknown> };

const CARRIER_COLS = "id, name, rfid_tag, tare_weight_kg, is_active";

async function replayed(client: PoolClient, registrationId: string, carrierId: string): Promise<RegistrationOutcome | null> {
  const { rows } = await client.query(
    `select carrier_id, action from carrier_registration_audit where registration_id = $1 order by performed_at`,
    [registrationId]
  );
  if (rows.length === 0) return null;
  if (!rows.some((r) => r.carrier_id === carrierId)) {
    return { kind: "refused", status: 409, body: { code: "registrationIdReused", error: "This registration was already used for another bin." } };
  }
  const { rows: c } = await client.query(`select ${CARRIER_COLS} from carriers where id = $1`, [carrierId]);
  return { kind: "ok", status: 200, body: { carrier: summarize(c[0]), replay: true } };
}

function sameAsExpected(row: { rfid_tag: string | null; tare_weight_kg: string }, expected: { rfidTag: string | null; tareWeightKg: number }) {
  return (row.rfid_tag ?? null) === expected.rfidTag && roundKg(Number(row.tare_weight_kg)) === expected.tareWeightKg;
}

function staleRefusal(current: CarrierSummary): RegistrationOutcome {
  return {
    kind: "refused",
    status: 409,
    body: { code: "stale", error: `${current.name} was changed while you were registering. Check its current tag and tare and try again.`, current },
  };
}

export async function registerBin(input: RegistrationInput, stationId: string, employeeId: string): Promise<RegistrationOutcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // The bin's row lock comes first, so a retry racing the original request
    // waits for it and is then answered as a replay.
    const { rows: targetRows } = await client.query(`select ${CARRIER_COLS} from carriers where id = $1 for update`, [input.carrierId]);
    const target = targetRows[0];
    if (!target) {
      await client.query("rollback");
      return { kind: "refused", status: 404, body: { code: "binNotFound", error: "That bin doesn't exist in LabourLink." } };
    }
    const replay = await replayed(client, input.registrationId, input.carrierId);
    if (replay) {
      await client.query("rollback");
      return replay;
    }
    if (!target.is_active) {
      await client.query("rollback");
      return {
        kind: "refused",
        status: 409,
        body: { code: "binInactive", error: `${target.name} is inactive. An administrator can activate it on Basic Data > Carriers.` },
      };
    }
    if (!sameAsExpected(target, input.expected)) {
      await client.query("rollback");
      return staleRefusal(summarize(target));
    }

    // One tag, one bin.
    const { rows: holderRows } = await client.query(
      `select ${CARRIER_COLS} from carriers where rfid_tag = $1 and id <> $2 for update`,
      [input.rfidTag, target.id]
    );
    const holder = holderRows[0];
    if (holder && input.moveFromCarrierId !== holder.id) {
      await client.query("rollback");
      return {
        kind: "refused",
        status: 409,
        body: {
          code: "tagOnOtherBin",
          error: `This tag is registered to ${holder.name}. Move it only if ${holder.name} was registered by mistake.`,
          holder: summarize(holder),
        },
      };
    }
    if (!holder && input.moveFromCarrierId !== null) {
      await client.query("rollback");
      return { kind: "refused", status: 409, body: { code: "stale", error: "The tag is no longer on the other bin. Try again.", current: summarize(target) } };
    }

    const currentTare = roundKg(Number(target.tare_weight_kg));
    const replacesTag = target.rfid_tag !== null && target.rfid_tag !== input.rfidTag;
    const replacesTare = currentTare > 0 && currentTare !== input.tareKg;
    if ((replacesTag || replacesTare) && !input.confirmOverwrite) {
      await client.query("rollback");
      return {
        kind: "refused",
        status: 409,
        body: {
          code: "needsConfirmation",
          error: `${target.name} already has ${[replacesTag ? `tag ${target.rfid_tag}` : null, replacesTare ? `tare ${currentTare.toFixed(2)} kg` : null]
            .filter(Boolean)
            .join(" and ")}. Confirm to replace.`,
          current: summarize(target),
          replacesTag,
          replacesTare,
        },
      };
    }

    let movedFrom: Record<string, unknown> | null = null;
    if (holder) {
      // The tag was registered to the wrong bin. Take it off that bin, and
      // if that bin's tare was set by the same mistaken registration, put
      // its previous tare back.
      const { rows: last } = await client.query(
        `select action, new_rfid_tag, new_tare_weight_kg, old_tare_weight_kg from carrier_registration_audit
         where carrier_id = $1 order by performed_at desc limit 1`,
        [holder.id]
      );
      const holderTare = roundKg(Number(holder.tare_weight_kg));
      const restoreTare =
        last[0] &&
        last[0].action === "register" &&
        last[0].new_rfid_tag === input.rfidTag &&
        roundKg(Number(last[0].new_tare_weight_kg)) === holderTare &&
        last[0].old_tare_weight_kg !== null
          ? roundKg(Number(last[0].old_tare_weight_kg))
          : holderTare;
      await client.query(`update carriers set rfid_tag = null, tare_weight_kg = $2, updated_at = now() where id = $1`, [holder.id, restoreTare]);
      await client.query(
        `insert into carrier_registration_audit
           (registration_id, carrier_id, station_id, source, action, old_rfid_tag, new_rfid_tag, old_tare_weight_kg, new_tare_weight_kg,
            moved_to_carrier_id, performed_by_employee_id, reason)
         values ($1, $2, $3, 'scale_station', 'move_tag', $4, null, $5, $6, $7, $8, $9)`,
        [
          input.registrationId,
          holder.id,
          stationId,
          holder.rfid_tag,
          holderTare,
          restoreTare,
          target.id,
          employeeId,
          `Tag moved to ${target.name}`,
        ]
      );
      movedFrom = { id: holder.id, name: holder.name, tareWeightKg: restoreTare, tareRestored: restoreTare !== holderTare };
    }

    await client.query(`update carriers set rfid_tag = $2, tare_weight_kg = $3, updated_at = now() where id = $1`, [
      target.id,
      input.rfidTag,
      input.tareKg,
    ]);
    await client.query(
      `insert into carrier_registration_audit
         (registration_id, carrier_id, station_id, source, action, old_rfid_tag, new_rfid_tag, old_tare_weight_kg, new_tare_weight_kg,
          measured_gross_kg, measured_samples_kg, indicator_status, stable_ms, empty_confirmed, overwrite_confirmed,
          moved_from_carrier_id, performed_by_employee_id)
       values ($1, $2, $3, 'scale_station', 'register', $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $14)`,
      [
        input.registrationId,
        target.id,
        stationId,
        target.rfid_tag,
        input.rfidTag,
        currentTare,
        input.tareKg,
        input.measured.grossKg,
        JSON.stringify(input.measured.samplesKg),
        input.measured.status,
        input.measured.stableMs,
        replacesTag || replacesTare,
        holder ? holder.id : null,
        employeeId,
      ]
    );
    await client.query("commit");

    const { rows: after } = await pool.query(`select ${CARRIER_COLS} from carriers where id = $1`, [target.id]);
    return {
      kind: "ok",
      status: 201,
      body: {
        carrier: summarize(after[0]),
        previous: { rfidTag: target.rfid_tag ?? null, tareWeightKg: currentTare },
        movedFrom,
      },
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    const code = (err as { code?: string; constraint?: string }).code;
    // Two registrations of the same tag at the same moment: the unique
    // index lets exactly one win.
    if (code === "23505" && (err as { constraint?: string }).constraint === "carriers_rfid_tag_key") {
      return { kind: "refused", status: 409, body: { code: "stale", error: "This tag was just registered to another bin. Try again." } };
    }
    if (code === "23505" && (err as { constraint?: string }).constraint === "carrier_registration_audit_once") {
      return { kind: "refused", status: 409, body: { code: "stale", error: "This registration is already being saved. Try again." } };
    }
    if (code === "40P01") {
      return { kind: "refused", status: 409, body: { code: "stale", error: "Another registration was saving at the same moment. Try again." } };
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function removeTag(input: RemoveTagInput, stationId: string, employeeId: string): Promise<RegistrationOutcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(`select ${CARRIER_COLS} from carriers where id = $1 for update`, [input.carrierId]);
    const c = rows[0];
    if (!c) {
      await client.query("rollback");
      return { kind: "refused", status: 404, body: { code: "binNotFound", error: "That bin doesn't exist in LabourLink." } };
    }
    const replay = await replayed(client, input.registrationId, input.carrierId);
    if (replay) {
      await client.query("rollback");
      return replay;
    }
    if (!sameAsExpected(c, input.expected)) {
      await client.query("rollback");
      return staleRefusal(summarize(c));
    }
    if (c.rfid_tag === null) {
      await client.query("rollback");
      return { kind: "refused", status: 409, body: { code: "noTag", error: `${c.name} has no tag to remove.`, current: summarize(c) } };
    }
    await client.query(`update carriers set rfid_tag = null, updated_at = now() where id = $1`, [c.id]);
    await client.query(
      `insert into carrier_registration_audit
         (registration_id, carrier_id, station_id, source, action, old_rfid_tag, new_rfid_tag, old_tare_weight_kg, new_tare_weight_kg,
          performed_by_employee_id, reason)
       values ($1, $2, $3, 'scale_station', 'remove_tag', $4, null, $5, $5, $6, $7)`,
      [input.registrationId, c.id, stationId, c.rfid_tag, Number(c.tare_weight_kg), employeeId, input.reason]
    );
    await client.query("commit");
    const { rows: after } = await pool.query(`select ${CARRIER_COLS} from carriers where id = $1`, [c.id]);
    return { kind: "ok", status: 201, body: { carrier: summarize(after[0]), previous: { rfidTag: c.rfid_tag, tareWeightKg: Number(c.tare_weight_kg) } } };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if ((err as { code?: string }).code === "23505") {
      return { kind: "refused", status: 409, body: { code: "stale", error: "This change is already being saved. Try again." } };
    }
    throw err;
  } finally {
    client.release();
  }
}

// Bins matching what the person typed. "77" finds "Bin 77", "Bin 077" and
// "77": the number at the end of the name, ignoring leading zeros. Anything
// else is a name search. Active bins only; never creates one.
export async function findBins(query: string): Promise<CarrierSummary[]> {
  const q = query.trim();
  if (!q) return [];
  const digits = /^\d{1,9}$/.test(q) ? Number(q) : null;
  const { rows } = await pool.query(
    `select ${CARRIER_COLS} from carriers
     where is_active = true
       and (($1::int is not null and substring(name from '(\\d{1,9})\\s*$')::int = $1::int)
         or ($1::int is null and lower(name) like $2))
     order by name limit 20`,
    [digits, `%${q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`]
  );
  return rows.map(summarize);
}

export async function binForTag(tag: string): Promise<CarrierSummary | null> {
  const { rows } = await pool.query(`select ${CARRIER_COLS} from carriers where rfid_tag = $1`, [tag]);
  return rows[0] ? summarize(rows[0]) : null;
}
