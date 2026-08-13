// Client-side mirror of server/src/lib/carrierBulk.ts's name-generation
// logic — used only for CarrierBulkAddModal's live "N carriers will be
// created" preview as the admin types. The server's own copy is the
// authoritative one that actually decides what gets created; this one only
// needs to match it closely enough for the preview to be a trustworthy
// estimate, re-confirmed by the real createdCount/skippedCount the server
// returns after Save.

export const MAX_BULK_CARRIERS = 500;

// Zero-pads `n` to `padding` digits, never truncating a number that's
// already wider than the requested padding.
export function padCarrierNumber(n: number, padding: number | null): string {
  const s = String(n);
  if (padding === null || padding <= s.length) return s;
  return s.padStart(padding, "0");
}

// Builds the full list of carrier names a bulk request would create, in
// order — e.g. prefix "Bin", start 1, end 3, padding 3 => ["Bin 001",
// "Bin 002", "Bin 003"].
export function buildBulkCarrierNames(prefix: string, startNumber: number, endNumber: number, padding: number | null): string[] {
  const names: string[] = [];
  for (let n = startNumber; n <= endNumber; n++) {
    names.push(`${prefix} ${padCarrierNumber(n, padding)}`);
  }
  return names;
}

// Same normalization as the DB's carriers_name_normalized_key index
// (lower(trim(name))).
export function normalizeCarrierName(name: string): string {
  return name.trim().toLowerCase();
}
