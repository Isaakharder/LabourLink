// Pure logic behind Basic Data > Carriers' "Bulk Add" feature (see
// routes/carriers.ts's POST /bulk) — kept separate from the route so the
// name-generation/validation rules are unit-testable without a database
// (carrierBulk.test.ts) the same way rowLayout.ts's placement math is.
// Mirrored on the client (web/src/lib/carrierBulk.ts) for the modal's live
// preview — the server copy here is the authoritative one actually used to
// create rows.

// Hard cap on a single bulk request — generous for real greenhouse bin
// counts (the example in the feature request is 50) while keeping a
// pathological request (e.g. end - start = 1,000,000) from building a huge
// VALUES list or hammering the carriers table in one call.
export const MAX_BULK_CARRIERS = 500;

export interface BulkCarrierRequest {
  prefix: string;
  startNumber: number;
  endNumber: number;
  padding: number | null;
  tareWeightKg: number;
  notes: string | null;
  isActive: boolean;
}

export type BulkCarrierValidation = { ok: true; request: BulkCarrierRequest } | { ok: false; errors: Record<string, string> };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Same rule POST/PATCH /api/carriers uses for tareWeightKg — kept in sync
// by hand (both are tiny) rather than shared, since one lives in a pure lib
// module and the other inline in the route.
export function parseTareWeightKg(value: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: false, error: "Tare weight is required" };
  }
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num) || num < 0) {
    return { ok: false, error: "Tare weight must be 0 or greater" };
  }
  return { ok: true, value: Math.round(num * 100) / 100 };
}

// Validates the raw request body for POST /api/carriers/bulk, coercing
// string-typed numeric fields (the client's <input type="number"> values
// arrive as JSON numbers already, but this stays defensive the same way
// the rest of carriers.ts is about body shapes). Every field gets its own
// error key so the modal can show them inline, matching the single-create
// form's existing errors object convention.
export function validateBulkCarrierRequest(body: Record<string, unknown>): BulkCarrierValidation {
  const errors: Record<string, string> = {};

  const prefix = typeof body.prefix === "string" ? body.prefix.trim() : "";
  if (!prefix) errors.prefix = "Prefix is required";
  else if (prefix.length > 60) errors.prefix = "Prefix must be 60 characters or fewer";

  const startNumber = typeof body.startNumber === "number" ? body.startNumber : Number(body.startNumber);
  if (!isFiniteNumber(startNumber) || !Number.isInteger(startNumber) || startNumber < 0) {
    errors.startNumber = "Start number must be a whole number of 0 or greater";
  }

  const endNumber = typeof body.endNumber === "number" ? body.endNumber : Number(body.endNumber);
  if (!isFiniteNumber(endNumber) || !Number.isInteger(endNumber) || endNumber < 0) {
    errors.endNumber = "End number must be a whole number of 0 or greater";
  } else if (isFiniteNumber(startNumber) && Number.isInteger(startNumber) && startNumber >= 0 && endNumber < startNumber) {
    errors.endNumber = "End number must be greater than or equal to the start number";
  }

  if (
    !errors.startNumber &&
    !errors.endNumber &&
    isFiniteNumber(startNumber) &&
    isFiniteNumber(endNumber) &&
    endNumber - startNumber + 1 > MAX_BULK_CARRIERS
  ) {
    errors.endNumber = `Bulk Add supports at most ${MAX_BULK_CARRIERS} carriers per batch`;
  }

  let padding: number | null = null;
  if (body.padding !== undefined && body.padding !== null && body.padding !== "") {
    const paddingNum = typeof body.padding === "number" ? body.padding : Number(body.padding);
    if (!isFiniteNumber(paddingNum) || !Number.isInteger(paddingNum) || paddingNum < 0 || paddingNum > 10) {
      errors.padding = "Padding must be a whole number between 0 and 10";
    } else {
      padding = paddingNum;
    }
  }

  const tareResult = parseTareWeightKg(body.tareWeightKg);
  if (!tareResult.ok) errors.tareWeightKg = tareResult.error;

  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  const isActive = body.isActive === undefined ? true : Boolean(body.isActive);

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    request: {
      prefix,
      startNumber,
      endNumber,
      padding,
      tareWeightKg: tareResult.ok ? tareResult.value : 0,
      notes,
      isActive,
    },
  };
}

// Zero-pads `n` to `padding` digits, never truncating a number that's
// already wider than the requested padding (e.g. padding=2 with n=100
// yields "100", not a lossy truncation).
export function padCarrierNumber(n: number, padding: number | null): string {
  const s = String(n);
  if (padding === null || padding <= s.length) return s;
  return s.padStart(padding, "0");
}

// Builds the full list of carrier names a bulk request would create, in
// order — e.g. prefix "Bin", start 1, end 3, padding 3 => ["Bin 001",
// "Bin 002", "Bin 003"]. Every generated name is guaranteed distinct from
// every other one in the same list (distinct integers always stringify to
// distinct strings under a fixed padding width), so only collisions
// against *existing* carriers ever need to be checked separately.
export function buildBulkCarrierNames(prefix: string, startNumber: number, endNumber: number, padding: number | null): string[] {
  const names: string[] = [];
  for (let n = startNumber; n <= endNumber; n++) {
    names.push(`${prefix} ${padCarrierNumber(n, padding)}`);
  }
  return names;
}

// Same normalization as the DB's carriers_name_normalized_key index
// (lower(trim(name))) — used to compare candidate bulk names against
// existing carriers without a round trip per name.
export function normalizeCarrierName(name: string): string {
  return name.trim().toLowerCase();
}
