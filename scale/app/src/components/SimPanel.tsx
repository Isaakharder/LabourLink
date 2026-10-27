// Simulation controls. Only rendered in simulation mode, and every endpoint
// it calls returns 404 unless the service itself is in simulation mode.
import { useCallback, useEffect, useState } from "react";
import { call } from "../api";
import type { Snapshot } from "../types";
import { clockTime } from "../format";

interface World {
  carriers: { id: string; name: string; rfidTag: string | null; tareG: number; isActive: boolean }[];
  employees: { id: string; name: string }[];
  claims: { id: string; employeeName: string; carrierName: string; occurredAt: string; clockTrusted: boolean; consumedBy: string | null }[];
  serverWeighings: { id: string; carrierName: string; weighedAt: string; status: string; employeeName: string | null }[];
  clockOffsetHours: number;
  serverOnline: boolean;
  unregisteredTag: string;
}

const NO_TAG = "__none__";

export function SimPanel({ s }: { s: Snapshot }) {
  const [open, setOpen] = useState(true);
  const [world, setWorld] = useState<World | null>(null);
  const [tag, setTag] = useState("0000000182225750");
  const [netKg, setNetKg] = useState("36.5");
  const [otherTag, setOtherTag] = useState("0000000182225751");
  const [employee, setEmployee] = useState("sim-employee-1");
  const [claimCarrier, setClaimCarrier] = useState("sim-carrier-01");
  const [minutesAgo, setMinutesAgo] = useState("20");
  const [trusted, setTrusted] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setWorld(await call<World>("/api/sim/world"));
    } catch {
      /* service restarting */
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 1500);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function act(path: string, body: unknown = {}) {
    setError(null);
    try {
      await call(path, { body });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  }

  const tagged = world?.carriers.filter((c) => c.rfidTag) ?? [];
  const placeTag = tag === NO_TAG ? null : tag;
  const tare = tagged.find((c) => c.rfidTag === tag)?.tareG ?? 27_500;
  const grossKg = (tare / 1000 + (parseFloat(netKg) || 0)).toFixed(2);
  const flags = s.rig?.flags;

  return (
    <aside className={`sim-panel${open ? " open" : ""}`} aria-label="Simulation controls">
      <button type="button" className="sim-toggle" onClick={() => setOpen(!open)}>
        {open ? "Hide simulator ▾" : "Simulator ▴"}
      </button>
      {open && world && (
        <div className="sim-body">
          <div className="sim-col">
            <h3>Scale + RFID</h3>
            <label>
              Bin tag
              <select value={tag} onChange={(e) => setTag(e.target.value)}>
                {tagged.map((c) => (
                  <option key={c.id} value={c.rfidTag!}>{c.name} · {c.rfidTag}</option>
                ))}
                <option value={world.unregisteredTag}>Unregistered tag · {world.unregisteredTag}</option>
                <option value={NO_TAG}>No tag (untagged load)</option>
              </select>
            </label>
            <label>
              Produce net kg
              <input value={netKg} onChange={(e) => setNetKg(e.target.value)} inputMode="decimal" />
            </label>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => act("/api/sim/place", { tag: placeTag, grossKg: parseFloat(grossKg) })}>Place bin ({grossKg} kg gross)</button>
              <button type="button" className="btn" onClick={() => act("/api/sim/remove")}>Remove bin</button>
            </div>
            <div className="row">
              <select value={otherTag} onChange={(e) => setOtherTag(e.target.value)}>
                {tagged.map((c) => (
                  <option key={c.id} value={c.rfidTag!}>{c.name}</option>
                ))}
              </select>
              <button type="button" className="btn" onClick={() => act("/api/sim/tag", { tag: otherTag })}>Second bin passes antenna</button>
            </div>
            {flags && (
              <div className="toggles">
                {([
                  ["wobble", "Wobble / motion"],
                  ["rfidRepeat", "Reader repeats reads"],
                  ["scaleOffline", "Scale offline"],
                  ["rfidOffline", "RFID offline"],
                  ["indicatorNet", "Indicator in NET mode"],
                  ["overload", "Overload"],
                ] as const).map(([k, label]) => (
                  <label key={k} className="toggle">
                    <input type="checkbox" checked={flags[k]} onChange={(e) => act("/api/sim/flags", { [k]: e.target.checked })} />
                    {label}
                  </label>
                ))}
                <label className="toggle">
                  <input type="checkbox" checked={world.serverOnline} onChange={(e) => act("/api/sim/flags", { serverOnline: e.target.checked })} />
                  LabourLink server reachable
                </label>
              </div>
            )}
          </div>

          <div className="sim-col">
            <h3>Picker phones (bin scans)</h3>
            <label>
              Picker
              <select value={employee} onChange={(e) => setEmployee(e.target.value)}>
                {world.employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </label>
            <label>
              Bin
              <select value={claimCarrier} onChange={(e) => setClaimCarrier(e.target.value)}>
                {world.carriers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <div className="row">
              <label>
                Scanned minutes ago
                <input value={minutesAgo} onChange={(e) => setMinutesAgo(e.target.value)} inputMode="numeric" />
              </label>
              <label className="toggle">
                <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} /> Phone clock OK
              </label>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => act("/api/sim/claim", { employeeId: employee, carrierId: claimCarrier, minutesAgo: parseInt(minutesAgo, 10) || 0, clockTrusted: trusted })}>
              Sync phone bin scan
            </button>
            <div className="row">
              <button type="button" className="btn" onClick={() => act("/api/sim/advance", { hours: 24 })}>Advance server clock +24 h</button>
              <span className="muted">offset {world.clockOffsetHours.toFixed(0)} h</span>
            </div>
            <ul className="sim-log">
              {world.claims.slice(0, 6).map((c) => (
                <li key={c.id}>
                  {clockTime(c.occurredAt)} {c.employeeName} → {c.carrierName}
                  {!c.clockTrusted && " (clock flagged)"}
                  {c.consumedBy && " ✓ used"}
                </li>
              ))}
            </ul>
          </div>

          <div className="sim-col">
            <h3>Simulated server</h3>
            <ul className="sim-log">
              {world.serverWeighings.slice(0, 10).map((w) => (
                <li key={w.id}>
                  {clockTime(w.weighedAt)} {w.carrierName}: <strong>{w.status}</strong>
                  {w.employeeName && ` · ${w.employeeName}`}
                </li>
              ))}
            </ul>
            {error && <div className="form-error">{error}</div>}
          </div>
        </div>
      )}
    </aside>
  );
}
