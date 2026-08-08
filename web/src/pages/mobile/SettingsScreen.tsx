import { FormEvent, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { useMessages } from "../../context/MessagesContext";
import { isPushMarkedEnabled, initAndroidPush, subscribeWebPush } from "../../lib/push";
import { isNativePlatform } from "../../lib/platform";

// PIN verification against the assigned employee's real hash lands once device
// pairing exists (Phase 3). This screen is the shell: enter a PIN, unlock a
// placeholder settings panel gated by that (not-yet-real) check.
export function SettingsScreen() {
  const { cachedEmployee, resetDevice } = useDevicePairing();
  const { refresh } = useMessages();
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(isPushMarkedEnabled());
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);

  async function handleEnableNotifications() {
    setNotifBusy(true);
    setNotifError(null);
    const result = isNativePlatform() ? await initAndroidPush(true, refresh) : await subscribeWebPush();
    setNotifBusy(false);
    if (result?.ok) {
      setNotifEnabled(true);
    } else {
      setNotifError(result?.reason ?? "Could not enable notifications on this device.");
    }
  }

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

      {/* Only ever shown behind this PIN gate, on its own screen — never
          auto-prompted on app launch. Permission is requested strictly in
          response to this button tap (see push.ts's subscribeWebPush /
          initAndroidPush), matching the requirement that notification
          permission is never requested automatically. */}
      <section className="mobile-settings-device-section">
        <h2>Notifications</h2>
        {notifEnabled ? (
          <p className="mobile-settings-device-note">Notifications are enabled on this device.</p>
        ) : (
          <>
            <p className="mobile-settings-device-note">
              Get notified when a new message arrives, even when LabourLink isn't open.
            </p>
            <button
              type="button"
              className="mobile-action-button mobile-action-primary"
              onClick={handleEnableNotifications}
              disabled={notifBusy}
            >
              {notifBusy ? "Enabling..." : "Enable notifications"}
            </button>
            {notifError && <p className="error-text">{notifError}</p>}
          </>
        )}
      </section>

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
