import type { ReactNode } from "react";
import type { Snapshot } from "../types";
import { clockTime, employeeLine, headline, kg, statusLabel } from "../format";

const EMPTY = <span className="placeholder">—</span>;

function Weight({ grams, prefix = "" }: { grams: number | null; prefix?: string }): ReactNode {
  if (grams === null) return EMPTY;
  return (
    <>
      {prefix}
      {kg(grams)} <span className="unit">kg</span>
    </>
  );
}

export function WeighScreen({ s }: { s: Snapshot }) {
  const h = headline(s);
  const p = s.phase;
  // During a WAIT the previous bin's values no longer describe what is on the
  // scale: show only the live gross until the scale has returned to zero.
  const recorded = s.waitForZero ? null : s.currentWeighing;
  const bin = s.waitForZero ? null : s.bin;
  const settling = p.phase === "settling";
  const settleProgress = settling ? 1 - s.settleRemainingMs / Math.max(1, s.params.settleMs) : 0;
  const emp = employeeLine(recorded, p);

  // Recorded values are frozen once saved; otherwise show live values.
  const gross = recorded ? recorded.grossG : s.reading?.weightG ?? null;
  const tare = recorded ? recorded.tareG : bin?.tareG ?? null;
  const net = recorded ? recorded.netG : s.waitForZero ? null : s.liveNetG;
  const indicatorNote = s.reading?.overload ? "OVERLOAD" : s.reading?.motion ? "Motion" : s.reading ? "Steady" : "";

  return (
    <div className="weigh">
      <section className={`status tone-${h.tone}${s.waitForZero ? " status-wait" : ""}`} role="status" aria-live="assertive">
        <div className="status-title">{h.title}</div>
        <div className="status-detail">{h.detail}</div>
        {settling && (
          <div className="settle" aria-label="Settling progress">
            <div className="settle-bar">
              <div className="settle-fill" style={{ width: `${Math.min(100, Math.max(0, settleProgress * 100))}%` }} />
            </div>
            <div className="settle-count">{Math.ceil(s.settleRemainingMs / 1000)} s</div>
          </div>
        )}
        {s.removalRemainingMs > 0 && <div className="status-sub">Scale clear, ready in {Math.ceil(s.removalRemainingMs / 1000)} s</div>}
      </section>

      <section className="card bin-card">
        <div className="label">Bin</div>
        <div className="bin-name">{recorded?.carrierName ?? bin?.carrierName ?? EMPTY}</div>
        <div className="muted mono">{recorded?.rfidTag ?? bin?.tag ?? (s.lastTag && p.phase === "idle" && s.lastTag.secondsAgo < 5 ? `Tag ${s.lastTag.tag}` : "")}</div>
      </section>

      <section className={`card employee-card emp-${emp.tone}`}>
        <div className="label">Employee</div>
        <div className="employee-name">{emp.name === "—" ? EMPTY : emp.name}</div>
        <div className="muted">{emp.note}</div>
      </section>

      <section className="card weights">
        <div className="weight-row">
          <div className="label">
            Gross {!recorded && indicatorNote && <span className={`chip ${s.reading?.motion ? "chip-warn" : "chip-ok"}`}>{indicatorNote}</span>}
          </div>
          <div className="weight-value">
            <Weight grams={gross} />
          </div>
        </div>
        <div className="weight-row">
          <div className="label">Carrier tare</div>
          <div className="weight-value">
            <Weight grams={tare} prefix="− " />
          </div>
        </div>
        <div className={`weight-row net${recorded ? " net-recorded" : ""}`}>
          <div className="label">Net {recorded ? <span className="chip chip-ok">Recorded</span> : net !== null ? <span className="chip">Live</span> : null}</div>
          <div className="weight-value net-value" data-testid="net">
            <Weight grams={net} />
          </div>
        </div>
      </section>

      <section className="card recent">
        <div className="label">Recent weighings</div>
        {s.recent.length === 0 ? (
          <div className="muted empty">No weighings yet</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Bin</th>
                <th className="num">Net kg</th>
                <th>Employee</th>
              </tr>
            </thead>
            <tbody>
              {s.recent.slice(0, 8).map((w) => {
                const st = statusLabel(w);
                return (
                  <tr key={w.id}>
                    <td className="mono">{clockTime(w.recordedAt)}</td>
                    <td>{w.carrierName}</td>
                    <td className="num mono">{kg(w.netG)}</td>
                    <td>
                      <span className={`status-chip st-${st.tone}`}>{st.text}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
