// Register Bins. Any LabourLink user signs in with their own email and PIN.
// While this screen is open the station does not weigh: the service measures
// one completely empty bin at a time (its RFID tag and stable gross weight,
// which becomes its tare), the person enters the bin's number, checks the
// details and confirms, and the bin's existing LabourLink carrier record gets
// the tag and tare. The LabourLink server re-checks everything and keeps an
// audit trail. Nothing is stored on this station: the session lives in the
// service's memory for 15 idle minutes.
import { FormEvent, useCallback, useEffect, useState } from "react";
import { call, ServiceError } from "../api";
import { kg, registrationHeadline } from "../format";
import type { Proposal, RegBin, RegistrationView, Snapshot } from "../types";

interface Session {
  token: string;
  name: string;
}

export function RegisterBins({ s, onDone }: { s: Snapshot; onDone: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = useCallback(async () => {
    if (session) {
      await call("/api/register/stop", { body: {}, sessionToken: session.token }).catch(() => {});
      await call("/api/session/logout", { body: {}, sessionToken: session.token }).catch(() => {});
    }
    setSession(null);
    onDone();
  }, [session, onDone]);

  async function signedIn(token: string, name: string) {
    try {
      await call("/api/register/start", { body: {}, sessionToken: token });
      setSession({ token, name });
      setError(null);
    } catch (err) {
      setError(err instanceof ServiceError ? err.message : "Could not open Register Bins");
    }
  }

  // The service closes Register Bins by itself when the session runs out.
  // Only a close seen after it was open counts: right after sign-in the
  // next snapshot may not show it open yet.
  const open = s.registration !== null;
  const [seenOpen, setSeenOpen] = useState(false);
  useEffect(() => {
    if (!session) setSeenOpen(false);
    else if (open) setSeenOpen(true);
    else if (seenOpen) setSession(null);
  }, [session, open, seenOpen]);

  if (!session || !s.registration) {
    return <Login mode={s.mode} error={error} onCancel={onDone} onLoggedIn={signedIn} />;
  }
  return <Registrar r={s.registration} session={session} onDone={done} onExpired={() => setSession(null)} />;
}

function Login({
  mode,
  error: outerError,
  onLoggedIn,
  onCancel,
}: {
  mode: Snapshot["mode"];
  error: string | null;
  onLoggedIn: (token: string, name: string) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ token: string; name: string }>("/api/session/login", { body: { email, pin } });
      setPin("");
      onLoggedIn(r.token, r.name);
    } catch (err) {
      setError(err instanceof ServiceError ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="register">
      <form className="card login" onSubmit={submit}>
        <h2>Register Bins</h2>
        <p className="muted">
          Sign in with your LabourLink email and PIN. Weighing pauses while Register Bins is open. Nothing is saved on this station.
        </p>
        <label>
          Email
          <input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          PIN
          <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} required />
        </label>
        {(error ?? outerError) && (
          <div className="form-error" role="alert">
            {error ?? outerError}
          </div>
        )}
        {mode === "simulation" && <p className="sim-hint">Simulation: picker@sim.local / 1234 (any user can register bins)</p>}
        {mode === "hardware-test" && (
          <p className="sim-hint">
            Hardware test: sign in to the test server with picker@sim.local / 1234. A bin registered here keeps its tag and tare only until the
            service restarts. To keep it, add it to testCarriers in /etc/labourlink-scale/config.json.
          </p>
        )}
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}

const kgText = (v: number) => `${v.toFixed(2)} kg`;

function Registrar({ r, session, onDone, onExpired }: { r: RegistrationView; session: Session; onDone: () => void; onExpired: () => void }) {
  const h = registrationHeadline(r);
  const proposal = r.phase.phase === "proposed" || r.phase.phase === "saving" ? r.phase.proposal : null;
  const [showCorrections, setShowCorrections] = useState(false);

  const handle401 = useCallback(
    (err: unknown) => {
      if (err instanceof ServiceError && err.status === 401) onExpired();
    },
    [onExpired]
  );

  return (
    <div className="register">
      <div className="register-head">
        <h2>Register Bins</h2>
        <span className="muted">Signed in as {session.name} · weighing is paused</span>
        <button type="button" className="btn btn-ghost" onClick={() => setShowCorrections((v) => !v)}>
          {showCorrections ? "Back to registering" : "Corrections"}
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done · back to weighing
        </button>
      </div>

      {showCorrections ? (
        <Corrections token={session.token} onAuthError={handle401} />
      ) : (
        <div className="register-grid register-bins">
          <section className={`card reg-status tone-${h.tone}`} aria-live="polite">
            <div className="label">1. Empty bin on the scale</div>
            <div className="reg-title">{h.title}</div>
            <div className="muted">{h.detail}</div>
            <div className="reg-weight mono">{r.reading?.weightG != null ? `${kg(r.reading.weightG)} kg` : "—"}</div>
            {r.phase.phase === "measuring" && r.settleRemainingMs > 0 && (
              <div className="muted">Settling: {Math.ceil(r.settleRemainingMs / 1000)} s</div>
            )}
            {r.clearRemainingMs > 0 && <div className="muted">Reading zero: {Math.ceil(r.clearRemainingMs / 1000)} s</div>}
            {proposal && (
              <dl className="reg-measured">
                <dt>RFID tag</dt>
                <dd className="mono">{proposal.tag}</dd>
                <dt>Proposed tare</dt>
                <dd className="mono">{kgText(proposal.grossG / 1000)}</dd>
              </dl>
            )}
            {r.phase.phase === "saved" && (
              <dl className="reg-measured">
                <dt>Bin</dt>
                <dd>{r.phase.binName}</dd>
                <dt>RFID tag</dt>
                <dd className="mono">{r.phase.rfidTag}</dd>
                <dt>Tare</dt>
                <dd className="mono">{kgText(r.phase.tareG / 1000)}</dd>
              </dl>
            )}
          </section>
          {proposal ? (
            <Confirm key={proposal.id} proposal={proposal} saving={r.phase.phase === "saving"} token={session.token} onAuthError={handle401} />
          ) : (
            <section className="card">
              <div className="label">2. Bin number</div>
              <div className="muted">Waiting for a measured empty bin.</div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function BinSearch({ token, onPick, onAuthError }: { token: string; onPick: (b: RegBin) => void; onAuthError: (e: unknown) => void }) {
  const [q, setQ] = useState("");
  const [bins, setBins] = useState<RegBin[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setBins([]);
      return;
    }
    let stop = false;
    const t = window.setTimeout(async () => {
      try {
        const r = await call<{ bins: RegBin[] }>(`/api/register/bins?q=${encodeURIComponent(q.trim())}`, { sessionToken: token });
        if (!stop) {
          setBins(r.bins);
          setError(null);
        }
      } catch (err) {
        onAuthError(err);
        if (!stop) setError(err instanceof ServiceError ? err.message : "Could not look up bins");
      }
    }, 250);
    return () => {
      stop = true;
      window.clearTimeout(t);
    };
  }, [q, token, onAuthError]);

  const press = (k: string) => setQ((cur) => (k === "⌫" ? cur.slice(0, -1) : k === "C" ? "" : cur + k));

  return (
    <div className="bin-search">
      <input className="search" aria-label="Bin number" placeholder="Bin number, e.g. 77" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="keypad" role="group" aria-label="Number keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map((k) => (
          <button key={k} type="button" className="btn btn-ghost" onClick={() => press(k)}>
            {k}
          </button>
        ))}
      </div>
      {error && <div className="form-error">{error}</div>}
      {q.trim() && bins.length === 0 && !error && <div className="muted">No active LabourLink bin matches “{q.trim()}”.</div>}
      <ul className="carrier-list">
        {bins.map((b) => (
          <li key={b.id}>
            <button type="button" className="carrier-item" onClick={() => onPick(b)}>
              <span className="carrier-name">{b.name}</span>
              <span className="mono muted">
                {b.rfidTag ?? "No tag"} · {kgText(b.tareWeightKg)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Confirm({ proposal, saving, token, onAuthError }: { proposal: Proposal; saving: boolean; token: string; onAuthError: (e: unknown) => void }) {
  const [bin, setBin] = useState<RegBin | null>(null);
  const [owner, setOwner] = useState<RegBin | null>(null);
  const [empty, setEmpty] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [move, setMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Which bin (if any) the measured tag is already registered to.
  useEffect(() => {
    let stop = false;
    call<{ tag: string | null; bin: RegBin | null }>("/api/register/tag-owner", { sessionToken: token })
      .then((r) => !stop && setOwner(r.bin))
      .catch(onAuthError);
    return () => {
      stop = true;
    };
  }, [proposal.id, token, onAuthError]);

  const tareKg = Math.round(proposal.grossG / 10) / 100;
  const ownedElsewhere = bin && owner && owner.id !== bin.id ? owner : null;
  const replacesTag = !!bin && bin.rfidTag !== null && bin.rfidTag !== proposal.tag;
  const replacesTare = !!bin && bin.tareWeightKg > 0 && Math.abs(bin.tareWeightKg - tareKg) >= 0.005;
  const ready = !!bin && empty && (!replacesTag && !replacesTare ? true : overwrite) && (!ownedElsewhere || move);

  function pick(b: RegBin) {
    setBin(b);
    setOverwrite(false);
    setMove(false);
    setMessage(null);
  }

  async function confirm() {
    if (!bin || !ready) return;
    setBusy(true);
    setMessage(null);
    try {
      await call("/api/register/confirm", {
        body: {
          carrierId: bin.id,
          expected: { rfidTag: bin.rfidTag, tareWeightKg: bin.tareWeightKg },
          emptyConfirmed: empty,
          confirmOverwrite: overwrite,
          moveFromCarrierId: ownedElsewhere && move ? ownedElsewhere.id : null,
        },
        sessionToken: token,
      });
    } catch (err) {
      onAuthError(err);
      if (err instanceof ServiceError) {
        const data = err.data as { current?: RegBin; holder?: RegBin };
        if (err.code === "stale" && data.current) pick(data.current); // show what the bin has now
        if (err.code === "tagOnOtherBin" && data.holder) setOwner(data.holder);
        setMessage(err.message);
      } else {
        setMessage("Could not save the registration");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="label">2. Bin number</div>
      {!bin ? (
        <BinSearch token={token} onPick={pick} onAuthError={onAuthError} />
      ) : (
        <div className="reg-confirm">
          <dl className="reg-measured">
            <dt>Bin</dt>
            <dd className="bin-name small">{bin.name}</dd>
            <dt>RFID tag</dt>
            <dd className="mono">{proposal.tag}</dd>
            <dt>Tare</dt>
            <dd className="mono">{kgText(tareKg)}</dd>
            <dt>Now in LabourLink</dt>
            <dd className="mono muted">
              {bin.rfidTag ?? "No tag"} · {kgText(bin.tareWeightKg)}
            </dd>
          </dl>
          {ownedElsewhere && (
            <label className="warn-check">
              <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />
              This tag is registered to <strong>{ownedElsewhere.name}</strong>. Move it to {bin.name} — only if {ownedElsewhere.name} was registered
              by mistake.
            </label>
          )}
          {(replacesTag || replacesTare) && (
            <label className="warn-check">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              Replace {bin.name}&apos;s {[replacesTag ? `tag ${bin.rfidTag}` : null, replacesTare ? `tare ${kgText(bin.tareWeightKg)}` : null].filter(Boolean).join(" and ")}
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} />
            This bin is completely empty
          </label>
          {message && (
            <div className="form-error" role="alert">
              {message}
            </div>
          )}
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={() => setBin(null)} disabled={busy || saving}>
              Choose another bin
            </button>
            <button type="button" className="btn btn-primary" disabled={!ready || busy || saving} onClick={confirm}>
              {busy || saving ? "Saving…" : `Register ${bin.name}`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// Corrections: take a tag off a bin (for example a bin registered by
// mistake). A wrong tare is corrected by registering the bin again.
function Corrections({ token, onAuthError }: { token: string; onAuthError: (e: unknown) => void }) {
  const [bin, setBin] = useState<RegBin | null>(null);
  const [reason, setReason] = useState("");
  const [sure, setSure] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!bin) return;
    setBusy(true);
    try {
      const r = await call<{ carrier: RegBin }>("/api/register/remove-tag", {
        body: { carrierId: bin.id, expected: { rfidTag: bin.rfidTag, tareWeightKg: bin.tareWeightKg }, reason: reason.trim() || null, confirm: true },
        sessionToken: token,
      });
      setMessage({ ok: true, text: `Tag removed from ${r.carrier.name}. Its tare is unchanged.` });
      setBin(null);
      setSure(false);
      setReason("");
    } catch (err) {
      onAuthError(err);
      setMessage({ ok: false, text: err instanceof ServiceError ? err.message : "Could not remove the tag" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="register-grid">
      <section className="card">
        <div className="label">Remove a tag from a bin</div>
        <p className="muted">
          To fix a wrong tare, register the bin again. To fix a tag registered to the wrong bin, register the right bin: you will be asked to
          move the tag. Every change is recorded with your name.
        </p>
        {!bin ? (
          <BinSearch token={token} onPick={(b) => { setBin(b); setMessage(null); }} onAuthError={onAuthError} />
        ) : (
          <>
            <div className="bin-name small">{bin.name}</div>
            <div className="muted mono">
              {bin.rfidTag ?? "No tag"} · {kgText(bin.tareWeightKg)}
            </div>
            {bin.rfidTag ? (
              <>
                <label>
                  Reason (optional)
                  <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
                </label>
                <label className="warn-check">
                  <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                  Remove tag {bin.rfidTag} from {bin.name}. The bin can&apos;t be weighed until it has a tag again.
                </label>
                <div className="row">
                  <button type="button" className="btn btn-ghost" onClick={() => setBin(null)}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-danger" disabled={!sure || busy} onClick={remove}>
                    Remove tag
                  </button>
                </div>
              </>
            ) : (
              <div className="muted">This bin has no tag.</div>
            )}
          </>
        )}
        {message && (
          <div className={message.ok ? "form-ok" : "form-error"} role="alert">
            {message.text}
          </div>
        )}
      </section>
    </div>
  );
}
