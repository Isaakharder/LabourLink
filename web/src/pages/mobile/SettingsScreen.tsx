import { FormEvent, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";

// PIN verification against the assigned employee's real hash lands once device
// pairing exists (Phase 3). This screen is the shell: enter a PIN, unlock a
// placeholder settings panel gated by that (not-yet-real) check.
export function SettingsScreen() {
  const { cachedEmployee, resetDevice } = useDevicePairing();
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);

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

      {/* Deliberately tucked away behind the PIN gate on its own screen,
          never on the main work screen — this is a supervisor/repurposing
          tool, not something an employee should stumble into mid-shift. */}
      <section className="mobile-settings-device-section">
        <h2>Device</h2>
        {cachedEmployee && (
          <p className="mobile-settings-device-note">
            Currently paired to {cachedEmployee.firstName} {cachedEmployee.lastName}.
          </p>
        )}

        {!confirmingReset ? (
          <button
            type="button"
            className="mobile-action-button mobile-action-danger"
            onClick={() => setConfirmingReset(true)}
          >
            Reset this device
          </button>
        ) : (
          <div className="mobile-settings-reset-confirm">
            <p>
              This clears the pairing on this phone only — it does not deactivate the device or affect
              anything on the server. The phone itself stays the same registered device, so pairing it
              again (to any employee) just re-approves it, rather than registering it as new hardware.
              Use this to hand the phone to a different employee.
            </p>
            <div className="mobile-confirm-actions">
              <button type="button" className="mobile-action-button mobile-action-danger-solid" onClick={resetDevice}>
                Confirm Reset
              </button>
              <button type="button" className="mobile-action-button" onClick={() => setConfirmingReset(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
