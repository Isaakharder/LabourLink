import { useState } from "react";

// There is no work data to sync yet (activities/work sessions are out of
// scope until later). This simulates the status transition so the screen and
// nav are real; the actual sync call gets wired in once there's data to move.
export function SyncScreen() {
  const [status, setStatus] = useState<"idle" | "syncing" | "synced">("idle");

  function handleSync() {
    setStatus("syncing");
    setTimeout(() => setStatus("synced"), 800);
  }

  return (
    <div className="mobile-sync">
      <h1>Sync</h1>
      <p className="sync-status-text">{status}</p>
      <button onClick={handleSync} disabled={status === "syncing"}>
        Sync now
      </button>
    </div>
  );
}
