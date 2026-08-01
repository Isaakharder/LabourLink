import { FormEvent, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { api, ApiError } from "../../lib/api";

function ForgotPinForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api<{ message: string }>("/api/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send reset email");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <h1>LabourLink</h1>
      <p>Reset your PIN</p>
      {message ? (
        <p className="success-text">{message}</p>
      ) : (
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
      )}
      {error && <p className="error-text">{error}</p>}
      {!message && (
        <button type="submit" disabled={submitting}>
          {submitting ? "Sending..." : "Send reset link"}
        </button>
      )}
      <button type="button" className="link-button" onClick={onBack}>
        Back to sign in
      </button>
    </form>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, pin);
    } catch {
      setError("Invalid email or PIN");
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "forgot") {
    return (
      <div className="login-screen">
        <ForgotPinForm onBack={() => setMode("login")} />
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>LabourLink</h1>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          PIN
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in..." : "Sign in"}
        </button>
        <button type="button" className="link-button" onClick={() => setMode("forgot")}>
          Forgot PIN?
        </button>
      </form>
    </div>
  );
}
