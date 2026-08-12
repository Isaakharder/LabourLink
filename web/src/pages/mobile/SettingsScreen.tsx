import { useState } from "react";
import { Link } from "react-router-dom";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { useMessages } from "../../context/MessagesContext";
import { useWorkSession } from "../../context/WorkSessionContext";
import { isPushMarkedEnabled, initAndroidPush, subscribeWebPush } from "../../lib/push";
import { isNativePlatform } from "../../lib/platform";

// No PIN gate, no on-device "Reset this device" — pairing a phone to a
// different employee, or taking it out of service, is an administrator
// action from desktop Setup > Devices (server/src/routes/devices.ts), never
// something reachable from the phone itself. A four-digit local PIN never
// verified against anything real used to gate a reset action here; removing
// that action removes the need for the gate too, rather than leaving a
// prompt in front of features (Notifications, Sync) that were never
// sensitive to begin with. See DeviceDeactivatedScreen for what an employee
// actually sees once an admin has deactivated/unassigned this phone.
export function SettingsScreen() {
  const { cachedEmployee } = useDevicePairing();
  const { refresh } = useMessages();
  const { online, pending, flush, me } = useWorkSession();
  // me.employee.securityRole (freshly fetched from the server on every /me
  // call, unlike cachedEmployee) is display-gating only — the routes behind
  // "NFC Diagnostic" and, later, tag registration each re-check the paired
  // employee's role server-side regardless of what this section shows.
  const isAdminMode = me?.employee.securityRole === "Administrator" || me?.employee.securityRole === "Manager";
  const [notifEnabled, setNotifEnabled] = useState(isPushMarkedEnabled());
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  async function handleSyncNow() {
    setSyncing(true);
    await flush();
    setSyncing(false);
  }

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

  return (
    <div className="mobile-settings">
      <h1>Settings</h1>
      {cachedEmployee && (
        <p className="mobile-settings-device-note">
          Paired to {cachedEmployee.firstName} {cachedEmployee.lastName}.
        </p>
      )}

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

      {/* Automatic sync already runs on mount, on reconnect, and whenever
          the offline queue changes (WorkSessionContext) — this is only a
          manual fallback for the rare gap where a request fails on a
          flaky connection without a real browser online/offline
          transition to trigger a retry. Routed through the same flush()
          WorkSessionContext itself uses, not a separate implementation, so
          it gets the same rejected-item and device-unpair handling. */}
      <section className="mobile-settings-device-section">
        <h2>Sync</h2>
        <div className="sync-status">
          <span className={`connection-dot ${online ? "" : "offline"}`} />
          {online ? "Online" : "Offline"}
        </div>
        <p className="mobile-settings-device-note">
          {pending > 0 ? `${pending} action(s) pending sync` : "All actions synced"}
        </p>
        <button
          type="button"
          className="mobile-action-button mobile-action-secondary"
          onClick={handleSyncNow}
          disabled={syncing || pending === 0}
        >
          {syncing ? "Syncing..." : "Sync now"}
        </button>
      </section>

      {/* Role-based, not a new on-device PIN — see the header comment above
          on why this codebase deliberately avoids on-device secrets. Shown
          only when the currently paired employee's server-verified role is
          Administrator/Manager; every route reached from here re-checks
          that role itself. Never translated (same convention as the rest of
          this screen — see i18n.ts's scope note). */}
      {isAdminMode && (
        <section className="mobile-settings-device-section">
          <h2>Admin Mode</h2>
          <div className="mobile-confirm-actions">
            <Link to="/mobile/settings/register-tag" className="mobile-action-button mobile-action-secondary">
              Register Existing Tag
            </Link>
            <Link to="/mobile/settings/write-tag" className="mobile-action-button mobile-action-secondary">
              Write New Tag
            </Link>
            <Link to="/mobile/settings/nfc-diagnostic" className="mobile-action-button mobile-action-secondary">
              NFC Diagnostic
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
