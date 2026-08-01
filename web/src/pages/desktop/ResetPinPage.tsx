import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";

export function ResetPinPage({ token }: { token: string }) {
  const navigate = useNavigate();
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (pin !== confirmPin) {
      setError("PINs do not match");
      return;
    }

    setSubmitting(true);
    try {
      await api("/api/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token, pin }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset PIN");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1>LabourLink</h1>
          <p className="success-text">PIN reset successfully. You can now sign in.</p>
          <button type="button" onClick={() => navigate("/", { replace: true })}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>LabourLink</h1>
        <p>Choose a new PIN</p>
        <label>
          New PIN
          <input
            type="password"
            inputMode="numeric"
            pattern="\d*"
            minLength={4}
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          Confirm PIN
          <input
            type="password"
            inputMode="numeric"
            pattern="\d*"
            minLength={4}
            maxLength={8}
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Resetting..." : "Reset PIN"}
        </button>
        <button type="button" className="link-button" onClick={() => navigate("/", { replace: true })}>
          Back to sign in
        </button>
      </form>
    </div>
  );
}
