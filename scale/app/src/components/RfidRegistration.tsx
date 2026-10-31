// RFID tag registration. Logs in with the administrator's own LabourLink
// email + PIN (the server's /api/auth/login) and saves through
// PATCH /api/carriers/:id, so permissions, tag validation and the
// duplicate-tag rule are exactly the Carriers page's. Nothing is stored on
// the station: the session lives in the service's memory for 15 idle minutes.
import { FormEvent, useCallback, useEffect, useState } from "react";
import { call, ServiceError } from "../api";
import type { Snapshot } from "../types";

interface AdminCarrier {
  id: string;
  name: string;
  rfidTag: string | null;
  tareWeightKg: number;
  isActive: boolean;
}

interface LastTag {
  tag: string;
  secondsAgo: number;
  carrierId: string | null;
  carrierName: string | null;
}

const FRESH_SECONDS = 30;

export function RfidRegistration({ s, onDone }: { s: Snapshot; onDone: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [adminName, setAdminName] = useState("");

  const logout = useCallback(async () => {
    if (token) await call("/api/admin/logout", { body: {}, adminToken: token }).catch(() => {});
    setToken(null);
  }, [token]);

  if (!token) {
    return <Login mode={s.mode} onCancel={onDone} onLoggedIn={(t, n) => { setToken(t); setAdminName(n); }} />;
  }
  return <Registrar token={token} adminName={adminName} onLogout={async () => { await logout(); onDone(); }} onExpired={() => setToken(null)} />;
}

function Login({ mode, onLoggedIn, onCancel }: { mode: Snapshot["mode"]; onLoggedIn: (token: string, name: string) => void; onCancel: () => void }) {
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ token: string; name: string }>("/api/admin/login", { body: { email, pin } });
      setPin("");
      onLoggedIn(r.token, r.name);
    } catch (err) {
      setError(err instanceof ServiceError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="register">
      <form className="card login" onSubmit={submit}>
        <h2>Register RFID tags</h2>
        <p className="muted">Sign in with your LabourLink administrator email and PIN. Nothing is saved on this station.</p>
        <label>
          Email
          <input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          PIN
          <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} required />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        {mode === "simulation" && <p className="sim-hint">Simulation logins: admin@sim.local / 1234 (Administrator), manager@sim.local / 1234 (Manager, refused)</p>}
        {mode === "hardware-test" && (
          <p className="sim-hint">
            Hardware test: sign in to the test server with admin@sim.local / 1234. A tag registered here is linked to a test bin until the service restarts.
            To keep it, add it to testCarriers in /etc/labourlink-scale/config.json.
          </p>
        )}
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </div>
      </form>
    </div>
  );
}

function Registrar({ token, adminName, onLogout, onExpired }: { token: string; adminName: string; onLogout: () => void; onExpired: () => void }) {
  const [lastTag, setLastTag] = useState<LastTag | null>(null);
  const [captured, setCaptured] = useState<LastTag | null>(null);
  const [search, setSearch] = useState("");
  const [carriers, setCarriers] = useState<AdminCarrier[]>([]);
  const [selected, setSelected] = useState<AdminCarrier | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<null | "assign" | "clear">(null);
  const [busy, setBusy] = useState(false);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ServiceError && err.status === 401) onExpired();
      setMessage({ kind: "error", text: err instanceof ServiceError ? err.message : "Something went wrong" });
    },
    [onExpired]
  );

  // Live "last tag read" from the reader.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const t = await call<LastTag | null>("/api/rfid/last");
        if (!stop) setLastTag(t);
      } catch {
        /* service restarting */
      }
    };
    poll();
    const id = window.setInterval(poll, 500);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await call<{ carriers: AdminCarrier[] }>(`/api/admin/carriers?search=${encodeURIComponent(search)}`, { adminToken: token });
      setCarriers(r.carriers);
      setSelected((cur) => (cur ? r.carriers.find((c) => c.id === cur.id) ?? cur : cur));
    } catch (err) {
      handleError(err);
    }
  }, [search, token, handleError]);

  useEffect(() => {
    const t = window.setTimeout(load, 250);
    return () => window.clearTimeout(t);
  }, [load]);

  const fresh = lastTag && lastTag.secondsAgo <= FRESH_SECONDS ? lastTag : null;
  const tagOwner = captured ? carriers.find((c) => c.rfidTag === captured.tag) : undefined;

  async function save(rfidTag: string | null) {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await call<{ carrier: AdminCarrier }>("/api/admin/rfid", { body: { carrierId: selected.id, rfidTag }, adminToken: token });
      setMessage({ kind: "ok", text: rfidTag ? `Tag ${rfidTag} is now linked to ${r.carrier.name}.` : `Tag removed from ${r.carrier.name}.` });
      setCaptured(null);
      setConfirming(null);
      await load();
    } catch (err) {
      handleError(err);
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="register">
      <div className="register-head">
        <h2>Register RFID tags</h2>
        <span className="muted">Signed in as {adminName}</span>
        <button type="button" className="btn btn-ghost" onClick={onLogout}>Sign out</button>
      </div>

      <div className="register-grid">
        <section className="card">
          <div className="label">1. Scan the bin's tag</div>
          {fresh ? (
            <>
              <div className="tag-big mono">{fresh.tag}</div>
              <div className="muted">
                Read {fresh.secondsAgo} s ago · {fresh.carrierName ? `currently linked to ${fresh.carrierName}` : "not linked to any bin"}
              </div>
              <button type="button" className="btn btn-primary" onClick={() => { setCaptured(fresh); setMessage(null); }}>Use this tag</button>
            </>
          ) : (
            <div className="muted scan-wait">Hold the tag at the RFID reader…</div>
          )}
          {captured && (
            <div className="captured">
              Selected tag: <strong className="mono">{captured.tag}</strong>
              <button type="button" className="btn btn-link" onClick={() => setCaptured(null)}>clear</button>
            </div>
          )}
        </section>

        <section className="card">
          <div className="label">2. Choose the bin</div>
          <input className="search" placeholder="Search by bin name or RFID tag" value={search} onChange={(e) => setSearch(e.target.value)} />
          <ul className="carrier-list">
            {carriers.map((c) => (
              <li key={c.id}>
                <button type="button" className={`carrier-item${selected?.id === c.id ? " selected" : ""}`} onClick={() => { setSelected(c); setConfirming(null); setMessage(null); }}>
                  <span className="carrier-name">{c.name}{!c.isActive && <span className="chip chip-warn">Inactive</span>}</span>
                  <span className="mono muted">{c.rfidTag ?? "Not assigned"}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <div className="label">3. Save</div>
          {!selected ? (
            <div className="muted">Choose a bin.</div>
          ) : (
            <>
              <div className="bin-name small">{selected.name}</div>
              <div className="muted">Current tag: <span className="mono">{selected.rfidTag ?? "Not assigned"}</span> · Tare {selected.tareWeightKg.toFixed(2)} kg</div>
              {captured && tagOwner && tagOwner.id !== selected.id && (
                <div className="form-error">This tag is already linked to {tagOwner.name}. Remove it there first.</div>
              )}
              {confirming === null && (
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!captured || busy || captured.tag === selected.rfidTag}
                    onClick={() => (selected.rfidTag ? setConfirming("assign") : save(captured!.tag))}
                  >
                    Link tag to {selected.name}
                  </button>
                  {selected.rfidTag && (
                    <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirming("clear")}>Remove tag</button>
                  )}
                </div>
              )}
              {confirming === "assign" && captured && (
                <div className="confirm">
                  Replace tag <span className="mono">{selected.rfidTag}</span> on {selected.name} with <span className="mono">{captured.tag}</span>?
                  <div className="row">
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>Cancel</button>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(captured.tag)}>Replace</button>
                  </div>
                </div>
              )}
              {confirming === "clear" && (
                <div className="confirm">
                  Remove tag <span className="mono">{selected.rfidTag}</span> from {selected.name}? The bin can't be weighed until it has a tag again.
                  <div className="row">
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>Cancel</button>
                    <button type="button" className="btn btn-danger" disabled={busy} onClick={() => save(null)}>Remove</button>
                  </div>
                </div>
              )}
            </>
          )}
          {message && <div className={message.kind === "ok" ? "form-ok" : "form-error"} role="alert">{message.text}</div>}
        </section>
      </div>
    </div>
  );
}
