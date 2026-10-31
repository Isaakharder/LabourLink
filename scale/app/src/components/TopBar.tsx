import { useEffect, useState } from "react";
import type { LinkStatus, Snapshot } from "../types";

function Pill({ label, status, extra }: { label: string; status: LinkStatus | { state: string; detail: string }; extra?: string }) {
  const good = ["connected", "online", "simulated"].includes(status.state);
  const sim = status.state.startsWith("simulated");
  return (
    <div className={`pill ${good ? "pill-ok" : "pill-bad"}${sim ? " pill-sim" : ""}`} title={status.detail}>
      <span className="dot" aria-hidden />
      <span className="pill-label">{label}</span>
      <span className="pill-state">{extra ?? stateText(status.state)}</span>
    </div>
  );
}

function stateText(state: string): string {
  switch (state) {
    case "connected":
    case "online":
      return "Connected";
    case "simulated":
      return "Simulated";
    case "simulated-offline":
      return "Sim offline";
    case "unrecognized":
      return "Data not recognised";
    case "offline":
      return "Offline";
    default:
      return "Disconnected";
  }
}

export function TopBar({ snapshot: s, serviceConnected, view, onToggleView }: { snapshot: Snapshot; serviceConnected: boolean; view: string; onToggleView: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // The indicator port can be open while the indicator sends nothing.
  const sc = s.connections.scale;
  const scale = s.scaleOnline || sc.state === "unrecognized"
    ? sc
    : { state: sc.state === "simulated" ? "simulated-offline" : "offline", detail: sc.state === "connected" ? "Port open, but no readings" : sc.detail };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">LabourLink Scale</span>
        <span className="station">{s.stationName}</span>
      </div>
      <div className="pills">
        {!serviceConnected && <Pill label="Service" status={{ state: "offline", detail: "Reconnecting to labourlink-scaled" }} />}
        <Pill label="Scale" status={scale} />
        <Pill label="RFID" status={s.connections.rfid} />
        <Pill label="LabourLink" status={s.connections.server} />
        <div className={`pill ${s.outbox.queued > 0 ? "pill-warn" : "pill-ok"}`} title="Weighings stored on this station but not yet sent">
          <span className="pill-label">To send</span>
          <span className="pill-state">{s.outbox.queued}</span>
        </div>
        <div className={`pill ${s.outbox.pending > 0 ? "pill-warn" : "pill-ok"}`} title="Weighings waiting for a verified employee assignment (up to 24 h)">
          <span className="pill-label">Awaiting assignment</span>
          <span className="pill-state">{s.outbox.pending}</span>
        </div>
      </div>
      <div className="topbar-right">
        <time className="clock">{now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
        <button type="button" className="btn btn-ghost" onClick={onToggleView}>
          {view === "weigh" ? "Register tags" : "Back to weighing"}
        </button>
      </div>
    </header>
  );
}
