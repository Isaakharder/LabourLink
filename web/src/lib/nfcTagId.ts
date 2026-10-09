// Canonical tag-ID formatting — the ONE place a raw NFC UID (a byte array,
// as both @capgo/capacitor-nfc's Android and iOS implementations hand it
// back via NfcTag.id) is turned into the hex string LabourLink stores,
// compares, and displays everywhere else: lib/nfc.ts's hexId() (kept as a
// thin re-export for its existing callers/tests), NfcDiagnosticScreen's raw
// display, and server/src/lib/nfcTagResolution.ts's normalizeHardwareId()
// (which assumes its input is ALREADY in this exact form — trimmed,
// uppercase, no separators — and only re-applies trim/uppercase itself; it
// does not know how to turn a byte array or a differently-separated string
// into that form). Added when the iOS platform was brought up: Android and
// iOS are two independent native NFC stacks reading the same physical
// Ridder/LabourLink tags, so this is the one place that difference is
// normalized away rather than trusted to happen to agree.
export function bytesToHex(bytes: number[]): string {
  return bytes
    .map((b) => (b & 0xff).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// Accepts either the raw byte array a scan produced, or an already-
// formatted hex string in any case and with any of the common separators a
// human or another tool might have inserted (colon, hyphen, whitespace) —
// normalizes both to the exact same canonical form: uppercase, zero-padded,
// two hex digits per byte, no separators. Every comparison or lookup
// against a stored tag ID (client-side duplicate-scan suppression, matching
// a scan against the offline tag-mapping cache, anything sent to the
// server) must go through this rather than reimplementing its own
// formatting — that's what "one shared tag-ID normalization function" means
// here.
export function normalizeTagId(input: number[] | string): string {
  const raw = typeof input === "string" ? input : bytesToHex(input);
  return raw.trim().toUpperCase().replace(/[\s:-]/g, "");
}

// Byte-order-tolerant EQUALITY CHECK ONLY — never used for storage,
// lookup, or anything sent to the server (normalizeTagId's forward-order
// canonical form remains the one and only form ever written or compared
// against a cached mapping). This exists purely as a diagnostic: different
// NFC stacks are documented to report some tag families' UID bytes in
// different orders — the best-known real-world case is Android's own
// ISO15693/NfcV handling, which has long reported that tag family's UID in
// the REVERSE of the order the tag transmits it on the wire (and of the
// order most other stacks, including iOS Core NFC, report), a platform
// quirk unrelated to LabourLink's own code. If a real Ridder tag scanned on
// Android and iPhone during the required cross-platform verification pass
// (see NfcDiagnosticScreen) ever produces two canonical IDs that don't
// match forward but DO match once one side is byte-reversed, that is a
// specific, actionable signal ("these two platforms read this tag's UID in
// opposite byte order") rather than "these are just two unrelated physical
// tags" — this function is what makes that distinction checkable, not an
// invitation to silently treat forward and reversed IDs as interchangeable
// identities anywhere else in the app.
export function isSameTagIdAnyByteOrder(a: number[], b: number[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  if (normalizeTagId(a) === normalizeTagId(b)) return true;
  return normalizeTagId(a) === normalizeTagId([...b].reverse());
}
