// Carrier RFID tag identifiers (carriers.rfid_tag, 065_carrier_rfid_tag.sql).
// Pure and DB-free so the Basic Data > Carriers API uses the same rule a
// future weighing-station registration/weighing flow will, and so it is
// unit-testable on its own (rfidTag.test.ts).
//
// Identifiers are opaque strings, never numbers: "0000000182225750" must keep
// its leading zeros. Normalization only removes formatting noise (surrounding
// and inner whitespace, letter case) so the same physical tag typed or
// pasted slightly differently still compares equal.

export const MAX_RFID_TAG_LENGTH = 64;

// Must match chk_carriers_rfid_tag_format in 065_carrier_rfid_tag.sql.
const RFID_TAG_RE = /^[0-9A-Z]{1,64}$/;

export function normalizeRfidTag(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

// Parses the optional rfidTag field of a carrier create/edit body. Blank,
// null or absent-as-null all mean "not assigned" (clears the tag).
export function parseRfidTag(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "RFID tag must be text" };
  const normalized = normalizeRfidTag(value);
  if (normalized === "") return { ok: true, value: null };
  if (normalized.length > MAX_RFID_TAG_LENGTH) {
    return { ok: false, error: `RFID tag must be ${MAX_RFID_TAG_LENGTH} characters or fewer` };
  }
  if (!RFID_TAG_RE.test(normalized)) return { ok: false, error: "RFID tag may only contain letters and digits" };
  return { ok: true, value: normalized };
}
