import { useCallback, useEffect, useRef, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { api } from "../../lib/api";
import { getOrCreateDeviceIdentifier } from "../../lib/device";

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

  const startPairing = useCallback(async () => {
    setError(null);
    setCode(null);
    try {
      const deviceIdentifier = getOrCreateDeviceIdentifier();
      const res = await api<RequestResponse>("/api/pairing/request", {
        method: "POST",
        body: JSON.stringify({ deviceIdentifier }),
      });
      setCode(res.pairingCode);
    } catch {
      setError("Could not start pairing. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
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
