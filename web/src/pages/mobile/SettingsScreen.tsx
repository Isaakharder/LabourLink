import { useState } from "react";
import { ChevronLeft } from "lucide-react";
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
  // The role gate above is necessary but not sufficient: an Administrator on
  // an iPhone (or any other non-Capacitor browser/PWA) still has no way to
  // scan NFC tags at all — Register Existing Tag/Write New Tag/NFC
  // Diagnostic all depend on the native @capgo/capacitor-nfc plugin, which
  // simply doesn't exist there. isNativePlatform() (lib/platform.ts)
  // resolves to Capacitor.isNativePlatform() specifically, never a viewport-
  // width guess, so a small-screen browser is never mistaken for the native
  // app here — see App.tsx's shouldRenderMobileApp for the one place a
  // viewport heuristic legitimately does apply (mobile layout vs. desktop),
  // a different question from "is native NFC hardware access available."
  const showAdminNfcTools = isAdminMode && isNativePlatform();
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
      {/* App navigation (React Router), never browser history — a plain
          history.back() could just as easily land outside LabourLink
          entirely (e.g. whatever page was open before this one was
          launched from a push notification or a fresh tab), which isn't
          "Home" at all. This always goes to exactly one place. */}
      <div className="mobile-settings-header">
        <Link to="/mobile/home" className="mobile-settings-back" aria-label="Back to Home">
          <ChevronLeft size={22} aria-hidden="true" />
        </Link>
        <h1>Settings</h1>
      </div>
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
          Administrator/Manager AND this is the native Capacitor app (see
          showAdminNfcTools above) — every route reached from here re-checks
          the role itself server-side too, but there's no point ever linking
          to an NFC screen that can't do anything on this device. Never
          translated (same convention as the rest of this screen — see
          i18n.ts's scope note). */}
      {showAdminNfcTools && (
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
