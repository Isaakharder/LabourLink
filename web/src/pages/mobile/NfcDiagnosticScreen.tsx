import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getNfcAvailability, isNfcSupported, NfcAvailability, ScannedTag } from "../../lib/nfc";
import { bytesToHex } from "../../lib/nfcTagId";
import { resolveScannedTag, ResolvedTagTarget } from "../../lib/nfcMappingCache";
import { useForegroundNfcScan } from "../../lib/useForegroundNfcScan";

interface ScanLogEntry extends ScannedTag {
  at: string; // locale time string, display only
  matchesPrevious: boolean | null; // null = nothing to compare yet
  // Read-only lookup against this device's OWN locally cached copy of the
  // production tag-mapping table (refreshTagMappingCache(), already
  // fetched via this device's normal paired-device session — see
  // HomeScreen.tsx's loadTagMappings) — no new network call, no event, no
  // write. This is the actual answer to "does the server resolve this
  // hardwareId to a row/bin," computed the exact same way HomeScreen's
  // real scan-to-switch flow would, just displayed here instead of acted
  // on.
  resolved: ResolvedTagTarget | null;
}

// Best-effort UTF-8 decode of an NDEF record's raw payload bytes, purely
// for display — a URI/text record's content is usually readable this way,
// but a record in some other encoding (or a raw binary format) won't
// decode to anything meaningful, hence the try/catch and the "(not valid
// UTF-8)" fallback rather than throwing or showing mojibake.
function tryDecodeUtf8(bytes: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return "(not valid UTF-8)";
  }
}

// Admin-only, read-only compatibility check — Step 1 of the NFC feature plan.
// Never calls anything on the plugin beyond starting/stopping a scan
// session; no write, erase, or makeReadOnly call exists anywhere in this
// screen. Purpose: confirm a real Ridder tag yields the same hardwareId
// across repeated scans before any registration/writing feature is built on
// top of that assumption. Plain English, no i18n — same convention as the
// rest of Settings (see i18n.ts's scope note).
export function NfcDiagnosticScreen() {
  const [availability, setAvailability] = useState<NfcAvailability | "checking">("checking");
  const [entries, setEntries] = useState<ScanLogEntry[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const lastHardwareId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supported = await isNfcSupported();
      if (cancelled) return;
      if (!supported) {
        setAvailability("unsupported");
        return;
      }
      const status = await getNfcAvailability();
      if (!cancelled) setAvailability(status);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { scanning, awaitingTap, startScan } = useForegroundNfcScan({
    active: availability === "ok",
    onTag: (tag: ScannedTag) => {
      setEntries((prev) => {
        const matchesPrevious = lastHardwareId.current === null ? null : tag.hardwareId === lastHardwareId.current;
        lastHardwareId.current = tag.hardwareId;
        const entry: ScanLogEntry = {
          ...tag,
          at: new Date().toLocaleTimeString(),
          matchesPrevious,
          resolved: resolveScannedTag(tag),
        };
        return [entry, ...prev].slice(0, 20);
      });
      setScanError(null);
    },
    onError: (message) => setScanError(message),
    label: "NfcDiagnosticScreen",
    // Distinct from HomeScreen/the picker sheets' own alertMessage text —
    // this screen is explicitly the admin compatibility-check tool (see its
    // own top-of-file comment), so the sheet should say so.
    iosAlertMessage: "Hold your iPhone near a tag to check it (diagnostic — nothing is written).",
  });

  return (
    <div className="mobile-settings">
      <h1>NFC Diagnostic</h1>
      <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
        Back to Settings
      </Link>

      <section className="mobile-settings-device-section">
        <h2>Status</h2>
        {availability === "checking" && <p className="mobile-settings-device-note">Checking NFC support…</p>}
        {availability === "unsupported" && (
          <p className="mobile-settings-device-note">This phone does not have NFC hardware.</p>
        )}
        {availability === "disabled" && (
          <p className="mobile-settings-device-note">
            This phone has NFC hardware, but the NFC radio is turned off. Enable it in the phone's system settings,
            then reopen this screen.
          </p>
        )}
        {availability === "unknown" && (
          <p className="error-text">Could not determine NFC status on this device.</p>
        )}
        {availability === "ok" && !awaitingTap && (
          <p className="mobile-settings-device-note">
            {scanning
              ? "Waiting for a tag — hold it near the back of the phone. Read-only — nothing is written to any tag on this screen."
              : "Ready. Hold a tag near the back of the phone. Read-only — nothing is written to any tag on this screen."}
          </p>
        )}
        {awaitingTap && (
          <>
            <p className="mobile-settings-device-note">
              Read-only — nothing is written to any tag on this screen. Tap Scan, then hold a tag near the top of the
              phone.
            </p>
            <button type="button" className="mobile-action-button mobile-action-primary" onClick={startScan}>
              Scan
            </button>
          </>
        )}
        {scanError && <p className="error-text">{scanError}</p>}
      </section>

      {availability === "ok" && (
        <section className="mobile-settings-device-section">
          <h2>Scans ({entries.length})</h2>
          {entries.length === 0 ? (
            <p className="mobile-settings-device-note">No scans yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {entries.map((entry, i) => (
                <li
                  key={i}
                  style={{
                    fontFamily: "monospace",
                    fontSize: 13,
                    padding: 8,
                    borderRadius: 6,
                    border: "1px solid var(--border-color, #ccc)",
                  }}
                >
                  <div>{entry.at}</div>
                  <div>hardwareId: {entry.hardwareId || "(blank)"}</div>
                  <div>ndef: {entry.hasNdefData ? "present" : "none"}</div>
                  <div>labourlinkTagUuid: {entry.labourlinkTagUuid ?? "—"}</div>
                  <div>isWritable: {entry.isWritable === null ? "unknown" : String(entry.isWritable)}</div>
                  <div>maxSize: {entry.maxSize === null ? "unknown" : `${entry.maxSize} bytes`}</div>
                  <div style={{ fontWeight: 700 }}>
                    resolves to: {entry.resolved ? `${entry.resolved.label} (${entry.resolved.targetType})` : "NOT FOUND in cached mapping"}
                  </div>
                  {entry.matchesPrevious !== null && (
                    <div className={entry.matchesPrevious ? undefined : "error-text"}>
                      {entry.matchesPrevious ? "matches previous scan" : "DIFFERENT from previous scan"}
                    </div>
                  )}

                  {/* --- Raw fields below: exactly what the native plugin
                      reported, unmodified — added for the iOS
                      identifier-extraction investigation. rawId is
                      distinguished from hardwareId ("") specifically to
                      show whether the native `id` key was present-but-
                      empty vs. absent entirely (see ScannedTag.rawId's own
                      comment in lib/nfc.ts). */}
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed var(--border-color, #ccc)" }}>
                    <div>rawId: {entry.rawId === null ? "(absent — native returned no id at all)" : `[${entry.rawId.join(", ")}]`}</div>
                    <div>techTypes: {entry.techTypes.length > 0 ? entry.techTypes.join(", ") : "(none reported)"}</div>
                    <div>tagType: {entry.tagType ?? "(none reported)"}</div>
                    <div>ndefRecords: {entry.ndefRecords.length}</div>
                    {entry.ndefRecords.map((record, ri) => (
                      <div key={ri} style={{ marginLeft: 12, marginTop: 4 }}>
                        <div>
                          record[{ri}]: tnf={record.tnf} type=[{record.type.join(", ")}] (
                          {bytesToHex(record.type) || "—"}) id=[{record.id.join(", ")}] ({bytesToHex(record.id) || "—"})
                        </div>
                        <div>
                          payload ({record.payload.length} bytes): hex={bytesToHex(record.payload) || "—"}
                        </div>
                        <div>payload as text: {tryDecodeUtf8(record.payload)}</div>
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
