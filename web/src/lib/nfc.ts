import type { NdefRecord, NfcEvent, NfcSessionEndEvent, NfcTag } from "@capgo/capacitor-nfc";
import { isIosNativePlatform, isNativePlatform } from "./platform";
import { bytesToHex } from "./nfcTagId";

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
  // stable hardware identifier a Ridder tag is registered by. Derived from
  // rawId via lib/nfcTagId.ts's normalizeTagId (every leading-zero byte
  // preserved) — "" when rawId is null or empty, never a guessed/fabricated
  // value.
  hardwareId: string;
  // Present only if the tag carries an NDEF record matching the versioned
  // LabourLink URI format (see LABOURLINK_URI_PREFIX) — a tag LabourLink
  // itself wrote. Resolution prefers this over hardwareId when both are
  // available (see the NFC feature plan's resolution rules).
  labourlinkTagUuid: string | null;
  hasNdefData: boolean;
  isWritable: boolean | null;
  maxSize: number | null;
  // --- Raw fields below: never read by resolution logic (see
  // nfcMappingCache.ts's resolveTagAgainstMappings, which only reads
  // hardwareId/labourlinkTagUuid above) — added for diagnostics
  // (NfcDiagnosticScreen) and cross-platform identifier investigation, so
  // the actual native payload is always inspectable rather than only the
  // already-interpreted fields above. ---
  //
  // The `id` field exactly as the native plugin reported it: `null` when
  // the key was absent entirely (confirmed cause on iOS: NfcPlugin.swift's
  // extractIdentifier() returned nil — see its own patched logging in
  // web/patches/@capgo+capacitor-nfc+8.2.3.patch — meaning the native layer
  // could not determine a raw identifier for this tag at all), distinct
  // from a present-but-empty array. hardwareId above is always derived from
  // this field (`rawId ?? []`), never invented independently.
  rawId: number[] | null;
  techTypes: string[];
  tagType: string | null;
  // The raw NDEF records exactly as reported, byte-for-byte — distinct
  // from labourlinkTagUuid, which is only the PARSED v1 LabourLink URI
  // payload (null for any tag carrying something else, including data this
  // app doesn't recognize as its own format at all). Empty array when
  // hasNdefData is false.
  ndefRecords: NdefRecord[];
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

// Thin re-export — lib/nfcTagId.ts is now the one canonical implementation
// (shared with any future cross-platform/display code that isn't scan-
// session-shaped), kept under this name because it's the existing public
// surface every current caller and test already imports.
export function hexId(bytes: number[]): string {
  return bytesToHex(bytes);
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
    rawId: tag.id ?? null,
    techTypes: tag.techTypes ?? [],
    tagType: tag.type ?? null,
    ndefRecords: tag.ndefMessage ?? [],
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

// Only one scan session may own the native reader at a time (see the NFC
// feature plan) — a new call always wins, forcibly stopping whatever
// session was previously active. Call sites already gate themselves so
// this rarely actually overlaps in practice (e.g. HomeScreen's foreground
// row-scan session yields before a picker sheet's own session starts), but
// this is the actual guarantee, not just call-site discipline — a bug or a
// race in that gating can never leave two sessions both trying to listen.
let activeStop: (() => void) | null = null;

// Passed straight through to NfcAdapter.enableReaderMode() by
// @capgo/capacitor-nfc's own androidReaderModeFlags option (see its
// CapacitorNfcPlugin.java — it already correctly calls enableReaderMode(),
// not enableForegroundDispatch(), which is what gives the foreground
// activity exclusive access to begin with). Values are Android's own
// stable, public android.nfc.NfcAdapter constants (confirmed against
// Android's official docs — hardcoded since JS has no way to import a
// native class's constants):
//   FLAG_READER_NFC_A              = 0x01
//   FLAG_READER_NFC_B              = 0x02
//   FLAG_READER_NFC_F              = 0x04
//   FLAG_READER_NFC_V              = 0x08
//   FLAG_READER_SKIP_NDEF_CHECK    = 0x80
//   FLAG_READER_NO_PLATFORM_SOUNDS = 0x100
// The first four plus NO_PLATFORM_SOUNDS match the plugin's own
// DEFAULT_READER_FLAGS; SKIP_NDEF_CHECK is added on top of that default,
// not instead of it (passing androidReaderModeFlags replaces the
// plugin's default entirely rather than merging with it).
//
// SKIP_NDEF_CHECK targets a real device bug: on a Ulefone Armor X13,
// plain enableReaderMode() (without this flag) still let the OEM's own
// "New tag collected" system tag viewer interrupt the foregrounded app on
// every scan, even though reader mode was already correctly suppressing
// standard Android NDEF/tag-app dispatch. Android's own docs describe
// this flag as preventing the platform from performing its own NDEF
// check on discovered tags — the step this OEM's viewer most plausibly
// hooks. It should not affect what LabourLink itself can read: hardwareId
// always comes straight from the raw Tag object (tag.getId()), and the
// plugin's onTagDiscovered reads NDEF itself directly
// (Ndef.connect()/getNdefMessage(), or the MIFARE Ultralight raw-page
// path existing Ridder tags use) rather than depending on the platform's
// own pre-check — but this still needs on-device confirmation (real
// Ridder tag + a real LabourLink-written tag) before being treated as
// settled, not just reasoned through from the platform's documented
// semantics.
export const ANDROID_READER_MODE_FLAGS =
  0x01 | // FLAG_READER_NFC_A
  0x02 | // FLAG_READER_NFC_B
  0x04 | // FLAG_READER_NFC_F
  0x08 | // FLAG_READER_NFC_V
  0x80 | // FLAG_READER_SKIP_NDEF_CHECK
  0x100; // FLAG_READER_NO_PLATFORM_SOUNDS

// Shown in Apple's own system scan sheet while an iOS session is open — has
// no Android equivalent (Android's reader mode has no visible UI at all, by
// design; see ANDROID_READER_MODE_FLAGS's NO_PLATFORM_SOUNDS/
// SKIP_NDEF_CHECK above). Used only when a caller doesn't supply its own
// `iosAlertMessage` to startScanSession — every real call site in this app
// does supply a context-specific one (see HomeScreen/RowPickerSheet/
// CarrierPickerSheet/NfcDiagnosticScreen/RegisterExistingTagScreen/
// WriteNewTagScreen), so this fallback mainly exists for completeness/tests.
export const DEFAULT_IOS_ALERT_MESSAGE = "Hold your iPhone near the LabourLink tag.";

// Maps @capgo/capacitor-nfc's iOS-only `nfcSessionEnd` event (see its own
// NfcSessionEndEvent type) to the clear, employee-facing message each
// reason needs — Android never emits this event at all (its silent reader
// mode has no session-lifecycle concept a JS caller needs to react to), so
// this is purely an iOS concern. Exported and pure so it's directly
// unit-testable without any plugin/session mocking.
//
// "invalidated" is CoreNFC's catch-all for every failure that isn't
// specifically a user-tapped Cancel or a timeout — the plugin's own iOS
// source (NfcPlugin.swift) invalidates a session with this generic reason
// for, among other things, "more than one tag detected" and "failed to
// connect to the tag." CoreNFC does not pass that distinguishing detail
// through to nfcSessionEnd (only `reason` is exposed, no message text), so
// this message is written to cover the single most common real cause
// (multiple tags near the phone at once) while still being accurate for
// the others.
export function nfcSessionEndMessage(reason: NfcSessionEndEvent["reason"]): string {
  switch (reason) {
    case "userCancelled":
      return "Scan cancelled.";
    case "sessionTimeout":
      return "Scan timed out — tap Scan again to try.";
    case "invalidated":
    default:
      return "Scan didn't complete — make sure only one tag is near the phone, then try again.";
  }
}

// Timestamped, greppable logging for reader-mode/session diagnosis (see the
// NFC feature plan's "add timestamped logging for Reader Mode enable/
// disable, activity pause/resume, tag detection and scan-session
// ownership") — deliberately console.log, not a debug-only wrapper, so it
// shows up in `adb logcat` (Capacitor's WebView console output is
// forwarded there) without needing a special build. Every call site below
// is tagged [nfc-js] to distinguish it from the native plugin's own
// [CapacitorNfcPlugin] logcat tag when correlating a capture.
function logNfc(label: string, message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[nfc-js ${Date.now()}] (${label}) ${message}`);
}

// Starts a foreground-dispatch scan session and calls onTag for every tag
// read until the returned stop function is called. A no-op outside a
// native platform (isNfcSupported()/getNfcAvailability() is what callers
// should check first to decide whether to show any scanning UI at all).
// Safe to call stop() before the async plugin setup below has actually
// finished — a fast mount+unmount (e.g. a sheet opened and immediately
// closed) never leaves a dangling active scan or a leaked listener.
//
// `label` is diagnostic only (identifies which caller owns the session in
// logcat — "HomeScreen", "RowPickerSheet", "RegisterExistingTagScreen",
// etc.) — defaults to "session" so existing call sites that don't pass one
// still log something identifiable.
//
// `iosAlertMessage` is iOS-only (shown in Apple's system scan sheet while
// this session is open — DEFAULT_IOS_ALERT_MESSAGE's own comment) and
// silently ignored on Android/web, same as every other iOS-only option
// below.
//
// Platform split, and why it's done HERE rather than left to the plugin's
// own per-platform defaults:
//   - Android: startScanning() is called with EXACTLY the same options
//     object this always sent — `invalidateAfterFirstRead: false` (an
//     Android no-op; only iOS reads that flag) plus
//     `androidReaderModeFlags: ANDROID_READER_MODE_FLAGS` — so Android's
//     existing silent, continuous, no-system-UI reader-mode scanning is
//     completely unchanged by any of the iOS work below.
//   - iOS: `iosSessionType: "tag"` (NFCTagReaderSession, not the default
//     NFCNDEFReaderSession) — required to read a raw hardwareId at all;
//     the existing Ridder tags this app resolves by hardwareId carry no
//     NDEF data (see this file's own top-of-file comment and
//     server/migrations/034_nfc_tag_mappings.sql's tag_kind='ridder'
//     column), and NFCNDEFReaderSession only ever detects NDEF-formatted
//     tags — it would silently never fire for them. `tag` mode also still
//     detects and reads NDEF tags (LabourLink's own written tags), so one
//     session type covers both tag kinds. `invalidateAfterFirstRead: true`
//     — every iOS session is a single Apple system-sheet presentation for
//     exactly one tag, closed the instant a tag is read (or the sheet is
//     cancelled/times out); iOS has no equivalent of Android's ambient,
//     indefinitely-open reader mode (see the iOS platform bring-up
//     report), so callers that want another scan call startScanSession
//     again — never silently, always from a fresh explicit tap.
// iOS-only options. keepOpen: deliver the first tag to onTag WITHOUT closing
// the native session (invalidateAfterFirstRead:false, no automatic stop()),
// so the caller can write to that still-connected tag and then call stop()
// itself — the Write New Tag flow. Ignored on Android/web.
export interface ScanSessionOptions {
  keepOpen?: boolean;
}

export function startScanSession(
  onTag: (tag: ScannedTag) => void,
  onError?: (message: string) => void,
  label = "session",
  iosAlertMessage?: string,
  options: ScanSessionOptions = {}
): () => void {
  const keepOpenOnIos = options.keepOpen === true && isIosNativePlatform();
  logNfc(label, "startScanSession called");
  if (activeStop) {
    logNfc(label, "preempting a previously active session (single reader-ownership guard)");
    activeStop();
  }

  let stopped = false;
  let listenerHandle: { remove: () => Promise<void> } | null = null;
  let sessionEndListenerHandle: { remove: () => Promise<void> } | null = null;
  let lastHardwareId: string | null = null;
  // Once a tag has actually been delivered to onTag, this session's job is
  // done — iOS's own invalidateAfterFirstRead:true then closes the native
  // session on its own, which (per CoreNFC's documented behavior) still
  // fires an nfcSessionEnd event, just not for any reason a caller should
  // ever see as an error. Without this guard, every single successful iOS
  // scan would ALSO report a spurious "scan didn't complete" error the
  // instant its own session cleanly closed itself.
  let tagReceived = false;

  if (isNativePlatform()) {
    (async () => {
      try {
        const { CapacitorNfc } = await import("@capgo/capacitor-nfc");
        if (stopped) return;
        listenerHandle = await CapacitorNfc.addListener("nfcEvent", (event: NfcEvent) => {
          if (!event.tag) return;
          const tag = toScannedTag(event.tag);
          if (shouldSuppressDuplicateScan(lastHardwareId, tag.hardwareId)) {
            logNfc(label, `tag suppressed (duplicate of last): hardwareId=${tag.hardwareId}`);
            return;
          }
          logNfc(label, `tag detected: hardwareId=${tag.hardwareId} hasNdefData=${tag.hasNdefData}`);
          lastHardwareId = tag.hardwareId;
          tagReceived = true;
          onTag(tag);
          // iOS: exactly one read per session. invalidateAfterFirstRead:
          // true (set unconditionally below for iOS) already tells the
          // native layer to close its own session after this read, but
          // this explicit call is the actual guarantee, not a hint —
          // reported bug on a physical iPhone: after a successful scan,
          // Apple's "Ready to Scan" sheet was observed staying open,
          // i.e. the JS side must never assume the native session already
          // tore itself down. stop() is idempotent (`stopped` guard), so
          // this is always safe even if the native side's own
          // self-invalidation already ran first. Never runs on Android —
          // its ambient, continuous, many-tags-per-session reader mode
          // (and every existing caller's own duplicate-scan handling built
          // on top of it) is completely unaffected.
          if (isIosNativePlatform() && !keepOpenOnIos) {
            stop();
          }
        });
        // iOS-only in practice (Android's plugin never emits this event at
        // all — see nfcSessionEndMessage's own comment) but harmless to
        // register unconditionally; simplest way to guarantee it's never
        // accidentally left un-wired for one platform.
        sessionEndListenerHandle = await CapacitorNfc.addListener("nfcSessionEnd", (event: NfcSessionEndEvent) => {
          if (tagReceived) {
            logNfc(label, `nfcSessionEnd (reason=${event.reason}) after a successful read — not an error, ignoring`);
            return;
          }
          if (stopped) {
            // We tore this session down ourselves (unmount, superseded by
            // a new session, caller-driven cleanup) — that is not a
            // failure this caller asked to hear about.
            logNfc(label, `nfcSessionEnd (reason=${event.reason}) after our own stop() — suppressing`);
            return;
          }
          const message = nfcSessionEndMessage(event.reason);
          logNfc(label, `nfcSessionEnd (reason=${event.reason}): ${message}`);
          onError?.(message);
        });
        if (stopped) {
          await listenerHandle.remove();
          listenerHandle = null;
          await sessionEndListenerHandle.remove();
          sessionEndListenerHandle = null;
          return;
        }

        if (isIosNativePlatform()) {
          logNfc(label, `calling native startScanning() with iosSessionType=tag keepOpen=${keepOpenOnIos}`);
          await CapacitorNfc.startScanning({
            iosSessionType: "tag",
            invalidateAfterFirstRead: !keepOpenOnIos,
            alertMessage: iosAlertMessage ?? DEFAULT_IOS_ALERT_MESSAGE,
          });
        } else {
          logNfc(label, `calling native startScanning() with androidReaderModeFlags=${ANDROID_READER_MODE_FLAGS}`);
          await CapacitorNfc.startScanning({
            invalidateAfterFirstRead: false,
            androidReaderModeFlags: ANDROID_READER_MODE_FLAGS,
          });
        }
        logNfc(label, "native startScanning() resolved — reader mode should now be active");
      } catch (err) {
        // On iOS this message comes straight from the native plugin
        // (NfcPlugin.swift) and is already specific per cause: no NFC
        // hardware, the simulator, or — most relevant here — a missing
        // 'TAG' reader-session-formats entitlement ("Ensure the TAG reader
        // entitlement is enabled." / "Make sure the ... entitlement
        // includes the 'TAG' format ..."). Forwarded verbatim rather than
        // re-summarized so that specificity isn't lost.
        logNfc(label, `startScanning failed: ${err instanceof Error ? err.message : String(err)}`);
        onError?.(err instanceof Error ? err.message : "Could not start NFC scanning.");
      }
    })();
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    logNfc(label, "stop() called");
    if (activeStop === stop) activeStop = null;
    if (!isNativePlatform()) return;
    (async () => {
      try {
        const { CapacitorNfc } = await import("@capgo/capacitor-nfc");
        if (listenerHandle) {
          await listenerHandle.remove();
          listenerHandle = null;
        }
        if (sessionEndListenerHandle) {
          await sessionEndListenerHandle.remove();
          sessionEndListenerHandle = null;
        }
        await CapacitorNfc.stopScanning();
        logNfc(label, "native stopScanning() resolved — reader mode should now be inactive");
      } catch {
        // Best-effort cleanup — nothing left listening matters more than a
        // clean rejection here.
      }
    })();
  };
  activeStop = stop;
  return stop;
}

export type NfcWriteFailureReason = "not_writable" | "insufficient_capacity" | "unsupported" | "write_failed" | "not_verified";
// verified: true only when the native layer read the tag back in the same
// session and it matched what was written (the patched iOS plugin). Android's
// write resolves without that check, so verified is false there and its
// existing separate "tap again to verify" step still applies.
export type NfcWriteResult = { ok: true; verified: boolean } | { ok: false; reason: NfcWriteFailureReason; message: string };

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
  context: { isWritable: boolean | null; maxSize: number | null },
  options: { iosSuccessMessage?: string } = {}
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
    const result = (await CapacitorNfc.write({
      records: [record],
      allowFormat: true,
      // Read by the patched iOS plugin only: shown in Apple's sheet once the
      // write has been verified, just before the caller closes the session.
      ...(options.iosSuccessMessage ? { successMessage: options.iosSuccessMessage } : {}),
    } as Parameters<typeof CapacitorNfc.write>[0])) as unknown as { verified?: boolean } | undefined;
    return { ok: true, verified: result?.verified === true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return {
      ok: false,
      reason: code === "WRITE_NOT_VERIFIED" ? "not_verified" : "write_failed",
      message: err instanceof Error ? err.message : "Could not write to this tag.",
    };
  }
}
