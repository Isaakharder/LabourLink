# Android kiosk pilot runbook (one Ulefone)

Status: **not approved yet.** Nothing in this runbook gets done until the owner explicitly approves it. That covers resetting a phone, enrolling it in an EMM, uploading to Play, and changing production.

Pilot phone (read-only inspection, 2026-10-12):

| | |
|---|---|
| Model | Ulefone Armor X12 (`Armor_X12`), Android 13 / API 33, security patch 2026-04-05, 32-bit (`armeabi-v7a`) |
| Build | `P1TFS23A7.GQU.Ulefone.HB.HJ.ABAMYBS8S2VH.20260513.V3.07` |
| ADB serial | `3112SH2010133658` |
| LabourLink | 1.8.5 (versionCode 14), installed from Google Play (`com.android.vending`) 2026-10-09 |
| Device owner | none. One Google account is signed in |
| Notifications | `POST_NOTIFICATIONS` **not granted**, so push messages can't currently arrive on this phone |

## 0. Decisions needed before anything else

1. **Which EMM.** It needs: QR enrolment of fully managed devices; single-app kiosk using real lock task, with the power menu allowed; managed Google Play; per-app managed configuration; a Wi-Fi policy; remote lock/wipe; and preferably an offline admin exit. **Chosen for the one-phone trial: TinyMDM** (owner-approved 2026-10-13). The exact policy, enrolment steps, capability status and acceptance tests are in `TINYMDM-PILOT.md`. ManageEngine MDM (free up to 25 devices) is the fallback if TinyMDM can't meet a hard requirement.
2. **How LabourLink reaches managed Google Play.** Either the closed-testing track is made available to the EMM's organisation (Play Console → the track → Managed Google Play / organisations), or the app is published privately to that organisation. Confirm in Play Console which option the current listing allows.
3. **Build to pilot.** The kiosk build is versionCode 15 / 1.9.0 (branch `feat/android-kiosk-pilot`). It has to be built and signed with the existing upload key on the signing machine (`npm run android:aab`) and uploaded to the track in decision 2. A locally signed APK can't update the Play-installed app: its signature won't match Play's app-signing key.

## 1. Before resetting the pilot phone (owner present)

1. Open LabourLink → Settings → **Sync details**. Pending events must be **0** and last sync recent. If pending isn't 0, connect to Wi-Fi, tap Sync now and wait. **Never reset with pending events above 0.**
2. Record the current assignment:
   - The employee shown in Settings ("Paired to …").
   - The device row on desktop Setup → Devices (name, employee, device identifier).
   - A photo of the Sync details screen.
3. Know what a factory reset destroys. Device identity, pairing and local data are deliberately excluded from backups (`allowBackup=false`). After re-enrolment the phone gets a **new identity** and must be paired again. That's expected. Unassign the old device row on desktop once the new pairing is confirmed.
4. Remove the Google account from the phone (Settings → Passwords & accounts) **before** the reset. Otherwise Factory Reset Protection will demand that account's password during setup.
5. Charge the phone above 50 % and have Wi-Fi details ready.

## 2. EMM setup (console, no phone needed)

1. Bind the EMM to a company Google account (managed Google Play enterprise).
2. Approve LabourLink in managed Google Play (see decision 2). Set auto-update to "high priority / as soon as possible" for the pilot.
3. Create a **kiosk policy** using the settings table in `README.md` (EMM kiosk policy LabourLink expects). The essentials:
   - Single-app kiosk: LabourLink. Power menu allowed. No status bar, notifications, Home or Recents.
   - Disallow safe boot, factory reset from Settings, adding users, unknown sources and other apps' overlays.
   - Lock screen off, so the phone wakes without a PIN.
   - Grant LabourLink's notification permission automatically.
   - **Auto-update Android System WebView, Google Play services and LabourLink through managed Google Play (high priority).** Old WebView builds cause the cold-start failures handled in `MainActivity`. The pilot Ulefone sat on its factory WebView 111 after the reset and failed a cold start the next morning (see `evidence/`).
   - **Disable the system app `com.pri.morning.kill`.** On Ulefone/PRIZE builds it force-stops LabourLink every night at about 03:01, even in kiosk mode. Seen on the pilot phone on 2026-10-13.
   - Wi-Fi: push the farm Wi-Fi network(s) as a policy.
   - Pilot only: leave USB debugging allowed.
4. Create a per-device **managed configuration** for LabourLink:
   - `kiosk_mode_enabled = true`
   - `maintenance_credential` = output of `node tools/android-kiosk/kiosk-credential-hash.mjs` (store the PIN in the password manager under "LabourLink maintenance – Pilot Ulefone 1")
   - `kiosk_device_label = Pilot Ulefone 1`
5. Generate the fully-managed **QR enrolment code** for that policy, including Wi-Fi if the EMM supports embedding it.

## 3. Enrolment (needs explicit approval)

1. Factory reset: Settings → System → Reset options → Erase all data. If Settings won't open, use recovery: power off, then hold Power + Volume Up.
2. On the Welcome screen, tap the screen 6 times in the same spot. The QR set-up reader opens.
3. Scan the EMM QR code and connect to Wi-Fi. The EMM agent becomes device owner, installs LabourLink from managed Google Play, applies the policy and launches LabourLink in kiosk mode.
4. LabourLink shows its pairing code. Approve it on desktop Setup → Devices for the same employee.
5. Check:
   - Home, Recents and swipe-down do nothing. Long-press Power shows Power off / Restart.
   - Hold the **Settings** heading (or "LabourLink" on the pairing screen) for 5 seconds. The maintenance screen asks for the PIN, and with the PIN shows version 1.9.0 (15), the identity, `Locked (lock task mode)`, Pending events 0 and the last sync.
6. Unassign the old device row on desktop.

If enrolment stops part-way, there are two ways back: the EMM's "retry" screen, or a recovery-mode reset (step 3.1). Neither depends on LabourLink.

## 4. Pilot validation on the phone (several days, including overnight)

The TinyMDM pilot uses the fuller acceptance table in `TINYMDM-PILOT.md` section 6, which adds the required WebView-update recovery test.

Use the phone for real work for several days. Tick off each item:

- [ ] Start work, switch activity, breaks, finish work.
- [ ] NFC: row, bin, activity and action tags (the emulator has no NFC).
- [ ] Recent jobs.
- [ ] Offline: turn Wi-Fi off at the router or walk out of range. Do actions, and the pending count rises. Come back, and it syncs to 0.
- [ ] Reboot from the power menu. It comes straight back into LabourLink, identity unchanged.
- [ ] Overnight: phone left on charge across midnight. Automatic midnight handling works, and in the morning the phone wakes into LabourLink without a PIN.
- [ ] Messages: send one from desktop while the phone sits on Home. Within about a minute, a full-screen message plus sound and vibration. Acknowledge works, and the unread badge clears.
- [ ] Notification permission is granted (EMM). Push arrives within seconds rather than the 60 s polling fallback.
- [ ] Long-press Power on the Ulefone shows the power menu, not an assistant. If an assistant opens, it can't launch other apps.
- [ ] Maintenance: wrong PIN rejected. Exit kiosk for 30 min, then re-enter. Wi-Fi settings returns locked. Restart LabourLink. Change PIN.
- [ ] Turning the screen off during a maintenance exit re-locks the phone.
- [ ] An app update through managed Play (upload 1.9.0 (16) to the same track) lands with pending events above 0 and keeps them, plus the identity and the kiosk lock.
- [ ] Battery life over a full shift compared with before.

## 5. Recovery procedures

| Situation | What to do |
|---|---|
| **Wi-Fi password changes** | Preferred: update the Wi-Fi policy in the EMM. Phones pick it up the next time they're online, so change it before the old network goes away, or bring each phone onto a hotspot. On the phone: hold the heading 5 s → PIN → **Wi-Fi settings**. That opens Android's Wi-Fi panel and re-locks as soon as you come back. |
| **LabourLink fails to start** | The native "LabourLink couldn't start" screen appears, with Retry. Hold its title 5 s for maintenance → Restart LabourLink. Or restart the phone from the power menu. Never "clear data" in the EMM: that deletes identity and pending work. |
| **WebView keeps failing** | As above. Then update Android System WebView through the EMM (system app updates must be allowed). If it's still broken, use the EMM's remote exit kiosk, then do Play Store → WebView → update on the phone. |
| **App update while offline work is pending** | Safe. Pending events live in SQLite inside the app's data, which an update never touches. Proven on the emulator (update with pending events above 0, then sync to 0). Let it sync after the update. |
| **Bad app release** | In Play Console, **halt** the rollout on the track straight away. Play can't downgrade, so fix forward: rebuild the last good code with a higher versionCode and upload. Pilot builds go to the pilot phone before anyone else. |
| **Maintenance PIN forgotten** | Generate a new credential with the hash tool and set `maintenance_credential` in the EMM. It overrides any locally changed PIN as soon as it reaches the phone. If the phone is offline, use the EMM's own offline admin exit if it has one. Otherwise bring the phone online, or as a last resort do a factory reset and re-enrol (only once pending is 0, or after accepting that unsynced work is lost). |
| **Phone stuck or unusable** | Power menu → Restart. Then EMM remote lock/exit-kiosk/reboot. As a last resort, factory reset from recovery mode (Power + Volume Up) and re-enrol by QR. |
| **Take the phone out of kiosk (temporary)** | Maintenance → Exit kiosk for 30 minutes. Or, in the EMM, set `kiosk_mode_enabled = false` or move the phone to a non-kiosk policy. LabourLink then behaves like a normal app. |
| **Return the phone to ordinary use** | 1) Maintenance screen shows Pending events 0. 2) Desktop: unassign the device. 3) EMM: retire/wipe the device. For a fully managed phone that's a factory reset, which removes the EMM, the kiosk and all data. 4) Set the phone up normally and install LabourLink from Play if needed. It behaves exactly like any personal install. |

## 6. Rollback of this change itself

The kiosk code is inert without the EMM's managed configuration. Rolling back means either shipping a build without it (fix forward with a higher versionCode), or simply leaving phones un-enrolled. No server, database or iOS change is involved.
