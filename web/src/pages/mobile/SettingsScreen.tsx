import { FormEvent, useState } from "react";

// PIN verification against the assigned employee's real hash lands once device
// pairing exists (Phase 3). This screen is the shell: enter a PIN, unlock a
// placeholder settings panel gated by that (not-yet-real) check.
export function SettingsScreen() {
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setUnlocked(pin.length >= 4);
  }

  if (!unlocked) {
    return (
      <div className="mobile-pin-gate">
        <h1>Enter PIN</h1>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoFocus
          />
          <button type="submit">Unlock</button>
        </form>
      </div>
    );
  }

  return (
    <div className="mobile-settings">
      <h1>Settings</h1>
      <p>Settings options are added as later phases land.</p>
    </div>
  );
}
