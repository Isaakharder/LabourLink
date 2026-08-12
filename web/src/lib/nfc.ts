import type { NdefRecord, NfcEvent, NfcTag } from "@capgo/capacitor-nfc";
import { isNativePlatform } from "./platform";

// Thin wrapper around @capgo/capacitor-nfc, same role lib/push.ts plays for
// @capacitor/push-notifications: the plugin is dynamically imported so this
// module still loads fine in a plain browser/PWA context (including the
// iPhone PWA, which never reaches any of the native-only branches below),
// and every plugin-shaped detail (byte arrays, NfcTag/NdefRecord shapes,
// NfcStatus strings) is translated into the small typed surface the rest of
// the app actually needs.
//
// Confirmed against a real Ridder tag on two Android phones (a Ulefone
// Armor X13 and a second "office" device): hardwareId is stable across
// repeated scans (5/5 matched, both devices), even on the one scan where
// NDEF came back empty/uncertain. NDEF (labourlinkTagUuid/hasNdefData/
// isWritable/maxSize) is therefore treated as best-effort everywhere in
// this file and by every caller — only hardwareId (existing Ridder tags)
// or a successfully parsed labourlinkTagUuid (new LabourLink tags) ever
// gate whether a scan is usable. writeTag() (Step 2) is the only function
// here that ever writes to a tag; registration/resolution never do.

export interface ScannedTag {
  // Hex-encoded raw tag identifier bytes (e.g. "04A1B2C3D4E5F6") — the
  // stable hardware identifier a Ridder tag is registered by.
  hardwareId: string;
  // Present only if the tag carries an NDEF record matching the versioned
  // LabourLink URI format (see LABOURLINK_URI_PREFIX) — a tag LabourLink
  // itself wrote. Resolution prefers this over hardwareId when both are
  // available (see the NFC feature plan's resolution rules).
  labourlinkTagUuid: string | null;
  hasNdefData: boolean;
  isWritable: boolean | null;
  maxSize: number | null;
}

export type NfcAvailability = "ok" | "disabled" | "unsupported" | "unknown";

// NDEF well-known URI record: TNF = 0x01 (well-known), type = 'U' (0x55).
// First payload byte is the URI Identifier Code (0x00 = no abbreviation,
// full URI follows verbatim) — LabourLink's own scheme isn't in the
// standard abbreviation table, so this is always 0x00 here.
const NDEF_TNF_WELL_KNOWN = 0x01;
const NDEF_TYPE_URI = 0x55;
const URI_IDENTIFIER_CODE_NONE = 0x00;

// Versioned so a future payload shape change (v2) can be told apart from
// today's — see the NFC feature plan. Only v1 is ever written or expected
// to resolve; a tag some future version wrote would fail to parse here
// rather than being silently misread.
export const LABOURLINK_URI_PREFIX = "labourlink://tag/v1/";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hexId(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// Pure — used both to build the record for writeTag() and mirrored by the
// parser below. Kept as one canonical construction so the bytes written and
// the bytes later expected to parse back out can never quietly diverge.
export function buildLabourlinkUriRecord(uuid: string): NdefRecord {
  const payload = [URI_IDENTIFIER_CODE_NONE, ...Array.from(new TextEncoder().encode(`${LABOURLINK_URI_PREFIX}${uuid}`))];
  return { tnf: NDEF_TNF_WELL_KNOWN, type: [NDEF_TYPE_URI], id: [], payload };
}

// Same suppression check startScanSession applies internally — exported
// separately so it's unit-testable without mocking the plugin/event stream.
// Presence-based, not time-based: holding the phone on one tag fires onTag
// exactly once; a *different* tag (or the same tag again after a different
// one was seen) fires again.
export function shouldSuppressDuplicateScan(lastHardwareId: string | null, newHardwareId: string): boolean {
  return lastHardwareId !== null && lastHardwareId === newHardwareId;
}

// Pure — no plugin/hardware involved — so this is directly unit-testable.
// Returns null for anything that isn't exactly one well-formed, v1
// LabourLink URI record: a tag with no NDEF data, a foreign NDEF payload
// (e.g. an unrelated Ridder record), a corrupt/truncated record, or a
// URI that parses but isn't a valid UUID all resolve to null, which the
// caller then falls back to hardwareId for.
export function parseLabourlinkTagUuid(records: NdefRecord[] | null | undefined): string | null {
  if (!records) return null;
  for (const record of records) {
    if (record.tnf !== NDEF_TNF_WELL_KNOWN) continue;
    if (record.type.length !== 1 || record.type[0] !== NDEF_TYPE_URI) continue;
    if (record.payload.length < 2 || record.payload[0] !== URI_IDENTIFIER_CODE_NONE) continue;
    let uri: string;
    try {
      uri = new TextDecoder().decode(new Uint8Array(record.payload.slice(1)));
    } catch {
      continue;
    }
    if (!uri.startsWith(LABOURLINK_URI_PREFIX)) continue;
    const candidate = uri.slice(LABOURLINK_URI_PREFIX.length);
    if (UUID_RE.test(candidate)) return candidate.toLowerCase();
  }
  return null;
}

function toScannedTag(tag: NfcTag): ScannedTag {
  return {
    hardwareId: hexId(tag.id ?? []),
    labourlinkTagUuid: parseLabourlinkTagUuid(tag.ndefMessage),
    hasNdefData: Boolean(tag.ndefMessage && tag.ndefMessage.length > 0),
    isWritable: tag.isWritable ?? null,
    maxSize: tag.maxSize ?? null,
  };
}

export async function isNfcSupported(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  try {
    const { CapacitorNfc } = await import("@capgo/capacitor-nfc");
    const { supported } = await CapacitorNfc.isSupported();
    return supported;
  } catch {
    return false;
  }
}

// getStatus() distinguishes "no NFC hardware at all" from "hardware present
// but the radio is off" — the two cases the employee-facing picker and the
// diagnostic screen need to tell apart (spec: "NFC is disabled" vs. "the
// phone lacks NFC" get different, clear messaging).
export async function getNfcAvailability(): Promise<NfcAvailability> {
  if (!isNativePlatform()) return "unsupported";
  try {
    const { CapacitorNfc } = await import("@capgo/capacitor-nfc");
    const { status } = await CapacitorNfc.getStatus();
    if (status === "NFC_OK") return "ok";
    if (status === "NFC_DISABLED") return "disabled";
    if (status === "NO_NFC") return "unsupported";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// Starts a foreground-dispatch scan session and calls onTag for every tag
// read until the returned stop function is called. A no-op outside a
// native platform (isNfcSupported()/getNfcAvailability() is what callers
// should check first to decide whether to show any scanning UI at all).
// Safe to call stop() before the async plugin setup below has actually
// finished — a fast mount+unmount (e.g. a sheet opened and immediately
// closed) never leaves a dangling active scan or a leaked listener.
export function startScanSession(onTag: (tag: ScannedTag) => void, onError?: (message: string) => void): () => void {
  let stopped = false;
  let listenerHandle: { remove: () => Promise<void> } | null = null;
  let lastHardwareId: string | null = null;

  if (isNativePlatform()) {
    (async () => {
      try {
        const { CapacitorNfc } = await import("@capgo/capacitor-nfc");
        if (stopped) return;
        listenerHandle = await CapacitorNfc.addListener("nfcEvent", (event: NfcEvent) => {
          if (!event.tag) return;
          const tag = toScannedTag(event.tag);
          if (shouldSuppressDuplicateScan(lastHardwareId, tag.hardwareId)) return;
          lastHardwareId = tag.hardwareId;
          onTag(tag);
        });
        if (stopped) {
          await listenerHandle.remove();
          listenerHandle = null;
          return;
        }
        await CapacitorNfc.startScanning({ invalidateAfterFirstRead: false });
      } catch (err) {
        onError?.(err instanceof Error ? err.message : "Could not start NFC scanning.");
      }
    })();
  }

  return () => {
    if (stopped) return;
    stopped = true;
    if (!isNativePlatform()) return;
    (async () => {
      try {
        const { CapacitorNfc } = await import("@capgo/capacitor-nfc");
        if (listenerHandle) {
          await listenerHandle.remove();
          listenerHandle = null;
        }
        await CapacitorNfc.stopScanning();
      } catch {
        // Best-effort cleanup — nothing left listening matters more than a
        // clean rejection here.
      }
    })();
  };
}

export type NfcWriteFailureReason = "not_writable" | "insufficient_capacity" | "unsupported" | "write_failed";
export type NfcWriteResult = { ok: true } | { ok: false; reason: NfcWriteFailureReason; message: string };

// Writes a v1 LabourLink URI record to whatever tag the plugin currently has
// in the field (the caller must have just captured a ScannedTag via
// startScanSession — `context` is that tag's own isWritable/maxSize, so a
// clearly non-writable or too-small tag is rejected before ever touching the
// plugin's write call). Never locks the tag: makeReadOnly()/erase() are not
// called anywhere in this file, matching the explicit "don't make tags
// permanently read-only during this phase" constraint. The caller is
// responsible for reading the tag back afterward (a fresh startScanSession
// tap) to verify the write actually took — this function only reports
// whether the write call itself succeeded.
export async function writeTag(
  uuid: string,
  context: { isWritable: boolean | null; maxSize: number | null }
): Promise<NfcWriteResult> {
  if (!isNativePlatform()) {
    return { ok: false, reason: "unsupported", message: "Writing is only available in the LabourLink Android app." };
  }
  if (context.isWritable === false) {
    return { ok: false, reason: "not_writable", message: "This tag is read-only and cannot be written to." };
  }
  const record = buildLabourlinkUriRecord(uuid);
  if (context.maxSize !== null && context.maxSize < record.payload.length) {
    return {
      ok: false,
      reason: "insufficient_capacity",
      message: `This tag only holds ${context.maxSize} bytes — a LabourLink tag ID needs ${record.payload.length}.`,
    };
  }
  try {
    const { CapacitorNfc } = await import("@capgo/capacitor-nfc");
    await CapacitorNfc.write({ records: [record], allowFormat: true });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: "write_failed",
      message: err instanceof Error ? err.message : "Could not write to this tag.",
    };
  }
}
