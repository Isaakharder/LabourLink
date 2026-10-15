# LabourLink Android kiosk mode

One Android build serves both personal phones and company kiosk phones.

| Device | What happens |
|---|---|
| Personal Android phone (Play install) | Unchanged. There's no managed configuration, so kiosk code never activates. |
| iOS | Unchanged. The kiosk plugin doesn't exist there, and `lib/kiosk.ts` is a no-op. |
| Company phone enrolled in the EMM (fully managed) | Kiosk mode: true Android Lock Task Mode, LabourLink is the only usable app. |

## Why an EMM, not an embedded DPC or our own AMAPI integration

- **Embedded DPC (LabourLink as its own device owner).** Since 2025, Play Protect blocks device-policy apps that aren't on Google's DPC allowlist during provisioning ("Harmful app blocked"). The approval process is opaque. A new custom DPC also can't use managed Google Play to deliver updates.
- **Android Management API directly.** Google's permissible-usage policy limits AMAPI to commercial EMM vendors. It explicitly excludes solutions "developed and used exclusively for first party in-house applications".
- **Third-party EMM.** This is the supported route. The EMM's own agent is device owner. It enrols the phone by QR code, applies the kiosk policy, delivers the Play-signed LabourLink through managed Google Play, and can remotely unlock, reconfigure or wipe the phone.

LabourLink only cooperates with the EMM. It reads the EMM's managed configuration and enters lock task itself.

## What's in the app

| Piece | File |
|---|---|
| Kiosk decision, credential check and lockout (pure Java, unit-tested) | `web/android/app/src/main/java/.../kiosk/KioskPolicy.java`, `KioskCredential.java` |
| Android wiring: managed config, `startLockTask`/`stopLockTask`, prefs | `kiosk/KioskController.java` |
| JS bridge, external-link blocking, message alert | `kiosk/KioskPlugin.java` |
| Native maintenance screen (works even if the WebView doesn't) | `kiosk/MaintenanceActivity.java` |
| Relaunch after an app update | `kiosk/KioskRelaunchReceiver.java` |
| Lock on resume, overlay hiding, relock on screen-off, restart | `MainActivity.java` |
| Managed-configuration schema shown in the EMM console | `res/xml/app_restrictions.xml` |
| Web side: status, 5-second hold, foreground messages, alerts | `web/src/lib/kiosk.ts`, `components/mobile/KioskBridge.tsx`, `KioskMaintenanceHold.tsx`, `lib/push.ts` |

Kiosk mode turns on only when both of these are true. Otherwise every hook returns early.

1. The EMM delivered the managed configuration `kiosk_mode_enabled = true` to LabourLink.
2. The device owner allowlisted LabourLink for lock task (`DevicePolicyManager.isLockTaskPermitted`).

LabourLink never calls `startLockTask()` unless it is allowlisted. Calling it without the allowlist would show Android's screen-pinning prompt instead of kiosk mode.

### Managed configuration (set per device in the EMM console)

| Key | Type | Value |
|---|---|---|
| `kiosk_mode_enabled` | bool | `true` |
| `maintenance_credential` | string | output of `node tools/android-kiosk/kiosk-credential-hash.mjs` |
| `kiosk_device_label` | string | optional, e.g. `Pilot Ulefone 1` |

To generate a maintenance credential:

```sh
node tools/android-kiosk/kiosk-credential-hash.mjs
# type a 6-32 digit PIN, press Enter; paste the printed pbkdf2-sha256$... line into the EMM
```

The PIN itself goes in the company password manager, one per device. The APK contains no PIN. The phone stores only the salted PBKDF2 hash and checks it locally, so maintenance unlock works offline. After five wrong attempts the screen locks out, starting at 30 s and doubling up to 15 min.

## EMM kiosk policy LabourLink expects

The test DPC under `test-dpc/` applies exactly this policy on the emulator. Use the same settings in the real EMM.

| Setting | Value | Test DPC call |
|---|---|---|
| Management mode | Fully managed / dedicated device (device owner) | `dpm set-device-owner` |
| LabourLink | Force-installed from managed Google Play, cannot be uninstalled | (sideloaded on emulator) |
| Lock task allowlist | LabourLink only | `setLockTaskPackages([LabourLink])` |
| Lock task features | **Global actions (power menu) only**. No Home, Recents, notifications, system info or keyguard | `setLockTaskFeatures(GLOBAL_ACTIONS)` |
| Status bar | Disabled | `setStatusBarDisabled(true)` |
| Lock screen | Disabled (no PIN on wake) | `setKeyguardDisabled(true)` |
| Safe boot | Disallowed | `DISALLOW_SAFE_BOOT` |
| Factory reset from Settings | Disallowed | `DISALLOW_FACTORY_RESET` |
| Add users | Disallowed | `DISALLOW_ADD_USER` |
| Unknown sources | Disallowed | `DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY` |
| Overlays from other apps | Disallowed | `DISALLOW_CREATE_WINDOWS` |
| System crash dialogs | Suppressed | `DISALLOW_SYSTEM_ERROR_DIALOGS` |
| Notification permission for LabourLink | Granted | `setPermissionGrantState(POST_NOTIFICATIONS, GRANTED)` |
| Kiosk launcher / Home | EMM kiosk launcher, which relaunches LabourLink | `addPersistentPreferredActivity(HOME → kiosk launcher)` |
| Managed config | the three keys above | `setApplicationRestrictions` |
| **Ulefone/PRIZE nightly app killer** | **Disable `com.pri.morning.kill`** (system app). Otherwise it force-stops LabourLink at about 03:01 every night, even in kiosk | `HIDE_PACKAGE` → `setApplicationHidden(true)` |
| **Android System WebView + LabourLink updates** | Auto-update through managed Google Play at high priority. A factory-reset phone with no Google account otherwise stays on its factory WebView (111 on the Armor X12) | n/a (needs managed Play) |
| USB debugging | **Allowed during the pilot** (diagnostics); disallow for the wider rollout | not set |

Some EMMs start the kiosk app in lock task themselves, for example with an AMAPI `installType: KIOSK`. LabourLink handles that too: it sees it is already locked and doesn't call `startLockTask()` again. The suite has a section for that launch mode.

## Emulator suite

```sh
# one-time: Android SDK + emulator (see the top of run-emulator-tests.sh), local API on :4000
cd web && npm run cap:sync:qa-emulator && (cd android && sh ./gradlew assembleDebug)
adb -s emulator-5554 install -r android/app/build/outputs/apk/debug/app-debug.apk
# pair it against the local API, start a job, then:
adb -s emulator-5554 install -r tools/android-kiosk/test-dpc/build/outputs/apk/debug/kiosk-test-dpc-debug.apk
adb -s emulator-5554 shell dpm set-device-owner com.linklogictechnologies.kiosktestdpc/.AdminReceiver
CRED=$(echo 482913 | node tools/android-kiosk/kiosk-credential-hash.mjs)
adb -s emulator-5554 shell am broadcast -n com.linklogictechnologies.kiosktestdpc/.CommandReceiver \
  -a com.linklogictechnologies.kiosktestdpc.APPLY_KIOSK --es credential "'$CRED'"
tools/android-kiosk/emulator/run-emulator-tests.sh
```

Every script under `emulator/` refuses to run against anything except an `emulator-*` serial or a `localhost` API.

## Pilot provisioning, recovery and rollback

See `PILOT-RUNBOOK.md`.
