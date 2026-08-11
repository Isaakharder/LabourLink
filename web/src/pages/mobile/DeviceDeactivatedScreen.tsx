import { useDevicePairing } from "../../context/DevicePairingContext";
import { DEACTIVATION_MESSAGES } from "../../lib/device";

// Shown only after a confirmed DEACTIVATION_ERROR_CODES rejection — an
// administrator genuinely deactivated this device, ended its assignment, or
// deactivated the employee (see DevicePairingContext's `deactivated`
// status). Deliberately does not auto-restart pairing the way plain
// "unpaired" does: whoever is holding the phone needs to see a clear reason
// and a deliberate action, not a silent jump back to a fresh pairing code as
// if nothing had happened. There is no self-service way to undo a
// deactivation from here — only an administrator can do that, from desktop
// Setup > Devices (see server/src/routes/devices.ts).
export function DeviceDeactivatedScreen() {
  const { deactivationCode, beginRepairing } = useDevicePairing();

  const message = deactivationCode
    ? DEACTIVATION_MESSAGES[deactivationCode]
    : "This phone is no longer paired. Contact an administrator.";

  return (
    <div className="pairing-screen">
      <h1>LabourLink</h1>
      <p className="device-deactivated-message">{message}</p>
      <p className="pairing-note">
        Once an administrator has re-approved this phone, tap below to request a new pairing code.
      </p>
      <button type="button" className="mobile-action-button" onClick={beginRepairing}>
        Start pairing again
      </button>
    </div>
  );
}
