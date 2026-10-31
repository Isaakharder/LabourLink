import { useState } from "react";
import { useSnapshot } from "./api";
import { TopBar } from "./components/TopBar";
import { WeighScreen } from "./components/WeighScreen";
import { RegisterBins } from "./components/RegisterBins";
import { call } from "./api";
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

  const hardwareTest = snapshot.mode === "hardware-test";
  return (
    <div className={`app${snapshot.simulated || hardwareTest ? " is-sim" : ""}`}>
      {snapshot.simulated && (
        <div className="sim-banner" role="status">
          SIMULATION MODE: no real scale, RFID reader or LabourLink server. Weighings here are test data and are never sent to LabourLink.
        </div>
      )}
      {hardwareTest && (
        <div className="sim-banner" role="status">
          HARDWARE TEST MODE: real scale and RFID reader, test bins only. Weighings here are test data and are never sent to LabourLink.
        </div>
      )}
      {snapshot.creditsEnabled === false && (
        <div className="trial-banner" role="status">
          TRIAL: credits are off for this station. Weighings are recorded and matched in LabourLink but are not counted as employee credits.
        </div>
      )}
      <TopBar snapshot={snapshot} serviceConnected={connected} view={view} onToggleView={() => setView(view === "weigh" ? "register" : "weigh")} />
      <main className="main">
        {view === "register" ? (
          <RegisterBins s={snapshot} onDone={() => setView("weigh")} />
        ) : snapshot.registration ? (
          // Register Bins was left open (e.g. the display restarted): weighing stays paused until it is closed.
          <div className="register">
            <div className="card login">
              <h2>Register Bins is open</h2>
              <p className="muted">Opened by {snapshot.registration.person}. Weighing is paused until it is closed.</p>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={() => call("/api/register/stop", { body: {}, sessionToken: "display" }).catch(() => {})}>
                  Close Register Bins and resume weighing
                </button>
              </div>
            </div>
          </div>
        ) : (
          <WeighScreen s={snapshot} />
        )}
      </main>
      {snapshot.simulated && <SimPanel s={snapshot} />}
    </div>
  );
}
