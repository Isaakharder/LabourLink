import { useMemo } from "react";

// Real pairing (generating a live code the server tracks, polling for desktop
// approval) is built in Phase 3. This is the visual shell only: a stable-looking
// placeholder code and "waiting" state so the mobile layout can be reviewed now.
export function PairingScreen() {
  const placeholderCode = useMemo(
    () => String(Math.floor(100000 + Math.random() * 900000)),
    []
  );

  return (
    <div className="pairing-screen">
      <h1>Pair this device</h1>
      <p>Enter this code on the desktop Setup page:</p>
      <div className="pairing-code">{placeholderCode}</div>
      <p className="pairing-status">Waiting for approval...</p>
      <p className="pairing-note">Code expires in 10 minutes.</p>
    </div>
  );
}
