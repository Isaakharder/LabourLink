import { useState } from "react";
import { useSnapshot } from "./api";
import { TopBar } from "./components/TopBar";
import { WeighScreen } from "./components/WeighScreen";
import { RfidRegistration } from "./components/RfidRegistration";
import { SimPanel } from "./components/SimPanel";

export function App() {
  const { snapshot, connected } = useSnapshot();
  const [view, setView] = useState<"weigh" | "register">("weigh");

  if (!snapshot) {
    return (
      <div className="boot">
        <div className="brand-mark">LabourLink Scale</div>
        <p>{connected ? "Loading…" : "Starting the scale service…"}</p>
      </div>
    );
  }

  return (
    <div className={`app${snapshot.simulated ? " is-sim" : ""}`}>
      {snapshot.simulated && (
        <div className="sim-banner" role="status">
          SIMULATION MODE: no real scale, RFID reader or LabourLink server. Weighings here are test data and are never sent to LabourLink.
        </div>
      )}
      <TopBar snapshot={snapshot} serviceConnected={connected} view={view} onToggleView={() => setView(view === "weigh" ? "register" : "weigh")} />
      <main className="main">
        {view === "weigh" ? <WeighScreen s={snapshot} /> : <RfidRegistration s={snapshot} onDone={() => setView("weigh")} />}
      </main>
      {snapshot.simulated && <SimPanel s={snapshot} />}
    </div>
  );
}
