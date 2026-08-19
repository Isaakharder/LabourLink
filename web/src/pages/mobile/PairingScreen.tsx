import { useEffect, useRef, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { api, ApiError } from "../../lib/api";
import { getOrCreateDeviceIdentifier } from "../../lib/device";
import { singleFlight } from "../../lib/singleFlight";

// A short, stable code appended to the (deliberately simple, non-scary)
// employee-facing message — real production incident: every affected
// phone showed the exact same generic "Could not start pairing" with a
// bare `catch {}` swallowing the actual cause, leaving no way to tell a
// 404 (route not deployed) from a 500 (server/migration problem) from a
// 401/403 (auth regression) from a genuine network/DNS/TLS failure that
// never reached the server at all — each needs a completely different
// fix. Never shown as the PRIMARY message (that stays simple for whoever
// is holding the phone) — always a small secondary line, exactly so it
// can be read aloud or photographed and relayed to whoever's diagnosing
// it, without turning the main screen into a stack trace.
export function diagnosticCodeFor(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code ? `HTTP ${err.status} (${err.code})` : `HTTP ${err.status}`;
  }
  if (err instanceof TypeError) {
    // fetch() itself throws a plain TypeError ("Failed to fetch" / "Load
    // failed") for DNS failure, TLS failure, or no network at all — the
    // request never reached the server, so there is no status code to
    // report at all.
    return "NETWORK_ERROR (no response reached the server)";
  }
  return `UNKNOWN_ERROR (${err instanceof Error ? err.message : String(err)})`;
}

interface RequestResponse {
  requestId: string;
  pairingCode: string;
  expiresAt: string;
}

interface StatusResponse {
  status: "pending" | "approved" | "expired" | "none";
}

const POLL_INTERVAL_MS = 3000;

export function PairingScreen() {
  const { markPaired } = useDevicePairing();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnosticCode, setDiagnosticCode] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // Single-flight so the mount effect below and a rapid "Try again" tap (or
  // any future caller) can never fire two overlapping POST
  // /api/pairing/request calls — each would otherwise create its own
  // pairing_requests row for an admin to sort out. Created once via useRef
  // (not module-level) so a fresh PairingScreen mount — e.g. after
  // DeviceDeactivatedScreen's "Start pairing again" — always starts with a
  // clean slate rather than inheriting stale in-flight state from a
  // previous mount. getOrCreateDeviceIdentifier() itself is already safe
  // against concurrent calls (synchronous read-then-write, no await in
  // between, so two calls in the same JS realm can never both see an empty
  // localStorage) — this guards the async request that follows it, which
  // does have a real concurrency window.
  const startPairingRef = useRef(
    singleFlight(async () => {
      setError(null);
      setDiagnosticCode(null);
      setCode(null);
      try {
        console.log("[device-identity] PairingScreen.startPairing invoked");
        const deviceIdentifier = getOrCreateDeviceIdentifier();
        const res = await api<RequestResponse>("/api/pairing/request", {
          method: "POST",
          body: JSON.stringify({ deviceIdentifier }),
        });
        setCode(res.pairingCode);
      } catch (err) {
        console.error("[pairing] POST /api/pairing/request failed:", err);
        setError("Could not start pairing. Check your connection and try again.");
        setDiagnosticCode(diagnosticCodeFor(err));
      }
    })
  );
  const startPairing = startPairingRef.current;

  useEffect(() => {
    console.log("[device-identity] PairingScreen mounted");
    startPairing();
  }, [startPairing]);

  useEffect(() => {
    if (!code) return;

    pollRef.current = window.setInterval(async () => {
      try {
        const deviceIdentifier = getOrCreateDeviceIdentifier();
        const res = await api<StatusResponse>(
          `/api/pairing/status?deviceIdentifier=${encodeURIComponent(deviceIdentifier)}`
        );
        if (res.status === "approved") {
          if (pollRef.current) window.clearInterval(pollRef.current);
          markPaired();
        } else if (res.status === "expired") {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setCode(null);
          setError("Pairing code expired.");
        }
      } catch {
        // Transient network issue while polling — just try again next tick.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [code, markPaired]);

  return (
    <div className="pairing-screen">
      <h1>LabourLink</h1>
      <p>Pair this device</p>
      {code ? (
        <>
          <div className="pairing-code">{code}</div>
          <p className="pairing-status">Waiting for approval...</p>
          <p className="pairing-note">
            Give this code to your administrator on the desktop Setup page.
          </p>
          <p className="pairing-note">Code expires in 10 minutes.</p>
        </>
      ) : (
        <p className="pairing-note">{error ?? "Starting pairing..."}</p>
      )}
      {/* Small, low-emphasis diagnostic line — not part of the main
          message above, so a regular employee isn't confronted with a
          technical error, but present and readable so it can be relayed
          (read aloud, photographed) to whoever is actually diagnosing a
          pairing failure. See diagnosticCodeFor's own comment. */}
      {diagnosticCode && <p className="pairing-diagnostic-code">Diagnostic: {diagnosticCode}</p>}
      {error && (
        <button className="mobile-action-button" onClick={startPairing}>
          Try again
        </button>
      )}
    </div>
  );
}
