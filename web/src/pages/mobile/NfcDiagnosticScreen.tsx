import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getNfcAvailability, isNfcSupported, startScanSession, NfcAvailability, ScannedTag } from "../../lib/nfc";

interface ScanLogEntry extends ScannedTag {
  at: string; // locale time string, display only
  matchesPrevious: boolean | null; // null = nothing to compare yet
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

  useEffect(() => {
    if (availability !== "ok") return;
    const stop = startScanSession(
      (tag) => {
        setEntries((prev) => {
          const matchesPrevious = lastHardwareId.current === null ? null : tag.hardwareId === lastHardwareId.current;
          lastHardwareId.current = tag.hardwareId;
          const entry: ScanLogEntry = { ...tag, at: new Date().toLocaleTimeString(), matchesPrevious };
          return [entry, ...prev].slice(0, 20);
        });
        setScanError(null);
      },
      (message) => setScanError(message),
      "NfcDiagnosticScreen"
    );
    return stop;
  }, [availability]);

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
        {availability === "ok" && (
          <p className="mobile-settings-device-note">
            Ready. Hold a tag near the back of the phone. Read-only — nothing is written to any tag on this screen.
          </p>
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
                  <div>hardwareId: {entry.hardwareId}</div>
                  <div>ndef: {entry.hasNdefData ? "present" : "none"}</div>
                  <div>labourlinkTagUuid: {entry.labourlinkTagUuid ?? "—"}</div>
                  <div>isWritable: {entry.isWritable === null ? "unknown" : String(entry.isWritable)}</div>
                  {entry.matchesPrevious !== null && (
                    <div className={entry.matchesPrevious ? undefined : "error-text"}>
                      {entry.matchesPrevious ? "matches previous scan" : "DIFFERENT from previous scan"}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
