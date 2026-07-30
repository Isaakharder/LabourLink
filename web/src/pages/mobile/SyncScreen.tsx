import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { flushQueue, getPendingCount } from "../../lib/offlineQueue";

export function SyncScreen() {
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(getPendingCount());
  const [syncing, setSyncing] = useState(false);

  const sync = useCallback(async () => {
    setSyncing(true);
    await flushQueue((path, body) => api(path, { method: "POST", body: JSON.stringify(body) })).catch(
      () => {}
    );
    setPending(getPendingCount());
    setSyncing(false);
  }, []);

  useEffect(() => {
    function goOnline() {
      setOnline(true);
      sync();
    }
    function goOffline() {
      setOnline(false);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [sync]);

  return (
    <div className="mobile-sync">
      <h1>Sync</h1>
      <div className="sync-status">
        <span className={`connection-dot ${online ? "online" : "offline"}`} />
        {online ? "Online" : "Offline"}
      </div>
      <p className="sync-status-text">
        {pending > 0 ? `${pending} action(s) pending sync` : "All actions synced"}
      </p>
      <button onClick={sync} disabled={syncing || pending === 0}>
        {syncing ? "Syncing..." : "Sync now"}
      </button>
    </div>
  );
}
