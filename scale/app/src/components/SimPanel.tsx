// Simulation controls. Only rendered in simulation mode, and every endpoint
// it calls returns 404 unless the service itself is in simulation mode.
import { useCallback, useEffect, useState } from "react";
import { call } from "../api";
import type { Snapshot } from "../types";
import { clockTime } from "../format";

interface World {
  carriers: { id: string; name: string; rfidTag: string | null; tareG: number; isActive: boolean }[];
  employees: { id: string; name: string }[];
  claims: SimClaim[];
  serverWeighings: SimWeighing[];
  serverOnline: boolean;
  unregisteredTag: string;
}

interface SimClaim {
  id: string;
  employeeName: string;
  carrierName: string;
  occurredAt: string;
  clockTrusted: boolean;
  consumedBy: string | null;
  state: "used" | "conflict" | "waiting" | "cycle_discarded" | "cycle_in_review" | "clock_flagged";
}

interface SimWeighing {
  id: string;
  carrierId: string;
  carrierName: string;
  weighedAt: string;
  status: string;
  employeeName: string | null;
}

const NO_TAG = "__none__";
const NEXT_USE = "next";
const MINUTES_AGO = "ago";

export const CLAIM_STATE_LABEL: Record<SimClaim["state"], string> = {
  used: "✓ credited this use",
  conflict: "⚠ conflict: flagged for supervisor, credit unchanged",
  waiting: "waiting for the bin's next weighing",
  cycle_discarded: "too late: that use expired (discarded)",
  cycle_in_review: "that use is under review",
  clock_flagged: "phone clock flagged: ignored",
};

const STATUS_LABEL: Record<string, string> = {
  credited: "credited",
  pending: "awaiting assignment",
  needs_review: "needs review",
  expired: "expired (discarded)",
};

/** Body for /api/sim/claim from the "Scan for" choice. */
export function claimBody(target: string, employeeId: string, carrierId: string, minutesAgo: string, clockTrusted: boolean) {
  if (target.startsWith("w:")) return { employeeId, timing: "beforeWeighing", weighingId: target.slice(2), clockTrusted };
  if (target === MINUTES_AGO) return { employeeId, timing: "minutesAgo", carrierId, minutesAgo: parseInt(minutesAgo, 10) || 0, clockTrusted };
  return { employeeId, timing: "now", carrierId, clockTrusted };
}

export function SimPanel({ s }: { s: Snapshot }) {
  const [open, setOpen] = useState(true);
  const [world, setWorld] = useState<World | null>(null);
  const [tag, setTag] = useState("0000000182225750");
  const [netKg, setNetKg] = useState("36.5");
  const [otherTag, setOtherTag] = useState("0000000182225751");
  const [employee, setEmployee] = useState("sim-employee-1");
  const [claimCarrier, setClaimCarrier] = useState("sim-carrier-01");
  const [target, setTarget] = useState<string>(NEXT_USE);
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
              Scan for
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value={NEXT_USE}>A bin's next use (scan now)</option>
                {world.serverWeighings.map((w) => (
                  <option key={w.id} value={`w:${w.id}`}>
                    The use weighed {clockTime(w.weighedAt)} · {w.carrierName} ({STATUS_LABEL[w.status] ?? w.status})
                  </option>
                ))}
                <option value={MINUTES_AGO}>Advanced: scanned N minutes ago</option>
              </select>
            </label>
            {!target.startsWith("w:") && (
              <label>
                Bin
                <select value={claimCarrier} onChange={(e) => setClaimCarrier(e.target.value)}>
                  {world.carriers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="row">
              {target === MINUTES_AGO && (
                <label>
                  Scanned minutes ago
                  <input value={minutesAgo} onChange={(e) => setMinutesAgo(e.target.value)} inputMode="numeric" />
                </label>
              )}
              <label className="toggle">
                <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} /> Phone clock OK
              </label>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => act("/api/sim/claim", claimBody(target, employee, claimCarrier, minutesAgo, trusted))}>
              Sync phone bin scan
            </button>
            <div className="row">
              <button type="button" className="btn" onClick={() => act("/api/sim/advance", { hours: 24 })}>Simulate 24 h passing</button>
              <span className="muted">expires unassigned weighings now; clocks are not shifted</span>
            </div>
            <ul className="sim-log">
              {world.claims.slice(0, 6).map((c) => (
                <li key={c.id}>
                  {clockTime(c.occurredAt)} {c.employeeName} → {c.carrierName}: {CLAIM_STATE_LABEL[c.state] ?? c.state}
                </li>
              ))}
            </ul>
          </div>

          <div className="sim-col">
            <h3>Simulated server</h3>
            <ul className="sim-log">
              {world.serverWeighings.slice(0, 10).map((w) => (
                <li key={w.id}>
                  {clockTime(w.weighedAt)} {w.carrierName}: <strong>{STATUS_LABEL[w.status] ?? w.status}</strong>
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
