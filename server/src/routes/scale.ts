// Station API for LabourLink Scale (scale/docs/ARCHITECTURE.md §5). Every
// route needs the station's own bearer token (requireScaleStation); nothing
// here accepts a human session.
//
//   GET  /api/scale/station            who am I, and are credits live
//   GET  /api/scale/carriers           bins with an RFID tag, for the station's offline cache
//   POST /api/scale/weighings          upload one weighing (idempotent on the station's id)
//   POST /api/scale/weighings/status   current outcome of up to 100 of this station's weighings
//
// Who gets credit is decided here, never on the station: see
// lib/scaleMatching.ts.
import { Router } from "express";
import { PoolClient } from "pg";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { parseRfidTag } from "../lib/rfidTag";
import {
  DUPLICATE_GUARD_MS,
  lockCarrier,
  PENDING_RECOVERY_MS,
  reconcileWeighingLocked,
  reconcileWeighings,
  recordWeighingEvent,
  scaleMatchingEnabled,
  STATION_CLOCK_AHEAD_LIMIT_MS,
} from "../lib/scaleMatching";
import { requireScaleStation } from "../middleware/scaleStationAuth";

const router = Router();
router.use(requireScaleStation);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Far above any bin (int4 grams), far below anything that could overflow.
const MAX_GRAMS = 5_000_000;
const MAX_SAMPLES = 500;
const MAX_STATUS_IDS = 100;

router.get(
  "/station",
  asyncHandler(async (req, res) => {
    const s = req.scaleStation!;
    res.json({ station: { id: s.id, name: s.name, creditsEnabled: s.creditsEnabled } });
  })
);

router.get(
  "/carriers",
  asyncHandler(async (_req, res) => {
    // Inactive bins are included so the station can say "inactive bin"
    // instead of "unregistered tag".
    const { rows } = await pool.query(
      `select id, name, rfid_tag, tare_weight_kg, is_active from carriers where rfid_tag is not null order by name`
    );
    res.json({
      carriers: rows.map((r) => ({
        id: r.id,
        name: r.name,
        rfidTag: r.rfid_tag,
        tareWeightKg: Number(r.tare_weight_kg),
        isActive: r.is_active,
      })),
    });
  })
);

interface WeighingInput {
  stationWeighingId: string;
  carrierId: string;
  rfidTag: string;
  grossG: number;
  tareG: number;
  netG: number;
  weighedAt: Date;
  samplesG: number[];
}

function isGrams(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_GRAMS;
}

export function parseWeighing(body: unknown): { ok: true; value: WeighingInput } | { ok: false; errors: Record<string, string> } {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  if (typeof b.stationWeighingId !== "string" || !UUID_RE.test(b.stationWeighingId)) errors.stationWeighingId = "must be a UUID";
  if (typeof b.carrierId !== "string" || !UUID_RE.test(b.carrierId)) errors.carrierId = "must be a UUID";
  const tag = parseRfidTag(b.rfidTag);
  if (!tag.ok || tag.value === null) errors.rfidTag = tag.ok ? "is required" : tag.error;
  for (const k of ["grossG", "tareG", "netG"] as const) {
    if (!isGrams(b[k])) errors[k] = `must be a whole number of grams between 1 and ${MAX_GRAMS}`;
  }
  if (!errors.grossG && !errors.tareG && !errors.netG && (b.netG as number) !== (b.grossG as number) - (b.tareG as number)) {
    errors.netG = "must equal grossG - tareG";
  }
  const weighedAt = typeof b.weighedAt === "string" ? new Date(b.weighedAt) : null;
  if (!weighedAt || isNaN(weighedAt.getTime())) errors.weighedAt = "must be an ISO timestamp";
  const samples = b.samplesG === undefined ? [] : b.samplesG;
  if (!Array.isArray(samples) || samples.length > MAX_SAMPLES || !samples.every((s) => Number.isInteger(s) && Math.abs(s) <= MAX_GRAMS)) {
    errors.samplesG = `must be at most ${MAX_SAMPLES} whole numbers of grams`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      stationWeighingId: (b.stationWeighingId as string).toLowerCase(),
      carrierId: (b.carrierId as string).toLowerCase(),
      rfidTag: (tag as { ok: true; value: string }).value,
      grossG: b.grossG as number,
      tareG: b.tareG as number,
      netG: b.netG as number,
      weighedAt: weighedAt!,
      samplesG: samples as number[],
    },
  };
}

// What the station shows for a weighing. employeeName is only ever present
// for a credit (and a voided credit, so the station can say whose credit was
// voided).
async function outcome(db: PoolClient | typeof pool, stationId: string, stationWeighingIds: string[]) {
  const { rows } = await db.query(
    `select w.station_weighing_id, w.status, w.pending_until, w.credits_live,
            case when w.employee_id is not null then trim(e.first_name || ' ' || coalesce(e.last_name, '')) end as employee_name
     from scale_weighings w
     left join employees e on e.id = w.employee_id
     where w.station_id = $1 and w.station_weighing_id = any($2::uuid[])`,
    [stationId, stationWeighingIds]
  );
  const out: Record<string, { status: string; employeeName: string | null; pendingUntil: string | null; creditsLive: boolean }> = {};
  for (const r of rows) {
    out[r.station_weighing_id] = {
      status: r.status,
      employeeName: r.employee_name ?? null,
      pendingUntil: r.status === "pending" ? new Date(r.pending_until).toISOString() : null,
      creditsLive: r.credits_live,
    };
  }
  return out;
}

router.post(
  "/weighings",
  asyncHandler(async (req, res) => {
    const station = req.scaleStation!;
    const parsed = parseWeighing(req.body);
    if (!parsed.ok) return res.status(400).json({ error: "Invalid weighing", errors: parsed.errors });
    const w = parsed.value;

    const client = await pool.connect();
    try {
      await client.query("begin");
      await lockCarrier(client, w.carrierId);

      const { rows: existing } = await client.query(
        `select id, carrier_id, gross_g, tare_g, net_g, weighed_at from scale_weighings
         where station_id = $1 and station_weighing_id = $2`,
        [station.id, w.stationWeighingId]
      );
      if (existing[0]) {
        // A retry after a lost response. Same weighing: answer with its
        // current outcome and change nothing. Different contents under the
        // same id: refuse, never overwrite.
        const e = existing[0];
        const same =
          e.carrier_id === w.carrierId &&
          e.gross_g === w.grossG &&
          e.tare_g === w.tareG &&
          e.net_g === w.netG &&
          new Date(e.weighed_at).getTime() === w.weighedAt.getTime();
        if (!same) {
          await client.query("rollback");
          return res.status(409).json({ error: "This station already sent a different weighing with this id" });
        }
        if (scaleMatchingEnabled()) await reconcileWeighingLocked(client, e.id);
        await client.query("commit");
        const result = await outcome(pool, station.id, [w.stationWeighingId]);
        return res.json(result[w.stationWeighingId]);
      }

      const { rows: carrierRows } = await client.query(`select id from carriers where id = $1`, [w.carrierId]);
      if (!carrierRows[0]) {
        await client.query("rollback");
        return res.status(422).json({ error: "Unknown bin", errors: { carrierId: "No LabourLink bin has this id" } });
      }

      // Anomalies the station should never produce. Each one holds the
      // weighing for review instead of crediting anyone.
      const { rows: neighbours } = await client.query(
        `select
           exists (select 1 from scale_weighings where carrier_id = $1 and weighed_at > $2) as later_exists,
           exists (select 1 from scale_weighings where carrier_id = $1 and weighed_at <= $2
                     and weighed_at > $2::timestamptz - make_interval(secs => $3)) as duplicate`,
        [w.carrierId, w.weighedAt, DUPLICATE_GUARD_MS / 1000]
      );
      const isDuplicate: boolean = neighbours[0].duplicate;
      const reviewReason = isDuplicate
        ? "The same bin was weighed less than five minutes earlier. Not counted."
        : neighbours[0].later_exists
          ? "A later weighing of this bin had already arrived, so the bin-use cycle can't be decided safely."
          : w.weighedAt.getTime() > Date.now() + STATION_CLOCK_AHEAD_LIMIT_MS
            ? "The station's clock is ahead of the server's."
            : null;

      const { rows: inserted } = await client.query(
        `insert into scale_weighings
           (station_id, station_weighing_id, carrier_id, rfid_tag, gross_g, tare_g, net_g, samples_g,
            weighed_at, pending_until, credits_live, is_duplicate, status, match_reason, resolved_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         returning id`,
        [
          station.id,
          w.stationWeighingId,
          w.carrierId,
          w.rfidTag,
          w.grossG,
          w.tareG,
          w.netG,
          JSON.stringify(w.samplesG),
          w.weighedAt,
          new Date(w.weighedAt.getTime() + PENDING_RECOVERY_MS),
          station.creditsEnabled,
          isDuplicate,
          reviewReason ? "needs_review" : "pending",
          reviewReason,
          reviewReason ? new Date() : null,
        ]
      );
      const id = inserted[0].id as string;
      await recordWeighingEvent(client, {
        weighingId: id,
        kind: "received",
        toStatus: reviewReason ? "needs_review" : "pending",
        reason: reviewReason,
        detail: { station: station.name, creditsLive: station.creditsEnabled },
      });
      if (!reviewReason && scaleMatchingEnabled()) await reconcileWeighingLocked(client, id);
      await client.query("commit");

      const result = await outcome(pool, station.id, [w.stationWeighingId]);
      res.status(201).json(result[w.stationWeighingId]);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if ((err as { code?: string }).code === "23505") {
        return res.status(409).json({ error: "This station already sent a different weighing with this id" });
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

router.post(
  "/weighings/status",
  asyncHandler(async (req, res) => {
    const station = req.scaleStation!;
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || ids.length > MAX_STATUS_IDS) {
      return res.status(400).json({ error: `ids must be an array of at most ${MAX_STATUS_IDS} weighing ids` });
    }
    const wanted = [...new Set(ids.filter((i): i is string => typeof i === "string" && UUID_RE.test(i)).map((i) => i.toLowerCase()))];
    if (wanted.length === 0) return res.json({ statuses: {} });

    // Expire pending weighings past their deadline (and pick up a missed
    // phone sync) before answering, so the answer never depends on the
    // sweep's timing.
    if (scaleMatchingEnabled()) {
      const { rows } = await pool.query(
        `select id from scale_weighings where station_id = $1 and station_weighing_id = any($2::uuid[]) and status = 'pending'`,
        [station.id, wanted]
      );
      await reconcileWeighings(rows.map((r) => r.id));
    }
    res.json({ statuses: await outcome(pool, station.id, wanted) });
  })
);

export default router;
