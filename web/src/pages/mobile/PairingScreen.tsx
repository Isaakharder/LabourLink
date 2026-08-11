import { useEffect, useRef, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { api } from "../../lib/api";
import { getOrCreateDeviceIdentifier } from "../../lib/device";
import { singleFlight } from "../../lib/singleFlight";

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
      setCode(null);
      try {
        console.log("[device-identity] PairingScreen.startPairing invoked");
        const deviceIdentifier = getOrCreateDeviceIdentifier();
        const res = await api<RequestResponse>("/api/pairing/request", {
          method: "POST",
          body: JSON.stringify({ deviceIdentifier }),
        });
        setCode(res.pairingCode);
      } catch {
        setError("Could not start pairing. Check your connection and try again.");
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
      {error && (
        <button className="mobile-action-button" onClick={startPairing}>
          Try again
        </button>
      )}
    </div>
  );
}
