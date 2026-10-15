# TinyMDM one-phone pilot

Status: **prepared, not approved.** Nothing below may be done until the owner
approves it in writing: no TinyMDM subscription, no Play upload, no PR merge,
no factory reset, no removal of the test DPC, no enrolment, no production
change.

Pilot phone: Ulefone Armor X12, serial `3112SH2010133658`, Android 13 (API 33,
32-bit), currently enrolled to the **test DPC** with LabourLink 1.9.0 (15) QA
debug pointing at a local test server. Evidence of that phase:
`evidence/2026-10-12_13-ulefone-armor-x12/FINDINGS.md`, archived at
`~/Projects/LabourLink-kiosk-evidence-2026-10-12_15.tgz`
(sha256 `aca17d4e…b2b0`, 2026-10-15).

Sources were TinyMDM's help centre, release notes and pricing page, Google's
managed Play documentation, and bayton.org. All were read on 2026-10-15.
TinyMDM's help pages carry no dates beyond "© 2025", so the menu names below
must be checked against the live console when we do it.

---

## 1. What TinyMDM can and cannot do for us

| # | Requirement | Status | Evidence / how we prove it in the pilot |
|---|---|---|---|
| 1 | Disable system package `com.pri.morning.kill` | **Unconfirmed** | The policy's *Apps management → Advanced apps management* has "Forbid the use of applications using their package name". The docs don't say whether this hides or disables a **system** package that has no launcher icon on a non-Samsung phone. The Knox-specific variant is Samsung-only. Proof: after enrolment, `dumpsys package com.pri.morning.kill` shows `hidden=true` or `enabled=2/3`, `dumpsys alarm` shows no morning alarm, and the phone survives a night with LabourLink alive at 03:01. |
| 2 | Deliver LabourLink's managed configuration | **Confirmed in general, unconfirmed for our build** | Policy → Apps management → app menu → *Configuration*. Values are per **policy**, and support tokens such as `$serial_number$`, `$imei$` and `$customfield1-3$`. Catch: Google reads the configuration **schema from the production version** of the app, not from a testing track. If LabourLink's production release has no `app_restrictions.xml`, TinyMDM shows no kiosk fields at all. Proof: the three keys appear in the console, and the maintenance screen shows `Locked (lock task mode)` and the device label. |
| 3 | Deliver a Play testing or private track | **Unconfirmed** | Google supports closed tracks for organisations (Play Console → Closed testing → Manage track → Testers → *Manage organizations* → TinyMDM's organisation ID). TinyMDM's docs never mention choosing a track. Documented fallback: the **TinyMDM Store** (private APK, ≤500 MB, managed configuration supported, admin-triggered updates). |
| 4 | Keep the power menu in single-app kiosk | **Unconfirmed** | Docs list only "Disable device switch off" (classic kiosk). Nothing confirms that Android's power menu stays available when it is unticked. Proof: long-press Power shows Power off / Restart. |
| 5 | Keep Android System WebView auto-updated | **Unconfirmed** | Policy default update mode "Always" lets Google update apps "without any time commitment". TinyMDM blocks manufacturer/system apps by default unless allowed by package name, and WebView isn't mentioned. There is no app-update maintenance window; the only window, "After midnight" (00:00-02:00), is for **OS** updates. Proof: WebView goes from factory 111 to the current version after enrolment. |
| 6 | Relaunch LabourLink after a WebView update, screen off | **Unconfirmed** | Docs only say the kiosk app reopens "even after a device restart" and when the device is unlocked. On 2026-10-13 under the test DPC, a WebView update killed LabourLink at 10:35, and it only came back when the screen was woken 23 h later. Proof: the required WebView-update test (section 6, test 15). |
| 7 | Report when LabourLink is not running | **Not supported (not documented)** | Compliance colours only cover policy and app *install* state. Alerts by email/SMS are for TinyMDM's own errors. No app-running or heartbeat alert is described. Recommended instead: a LabourLink **server-side** heartbeat (see section 7). |

### Verdict

None of the hard requirements is shown to be **unsupported**, so TinyMDM stays
the pilot candidate. Four hard requirements (1, 3, 5, 6) are unconfirmed, and
so is the power menu (4). Before resetting the phone, ask TinyMDM support the
questions in section 2 (allowed during the free trial, no purchase). Then stop
and switch EMM if TinyMDM answers **no** to any of these:

- disabling a non-Samsung system package (1),
- delivering a closed track **or** a TinyMDM Store APK with managed configuration (2/3),
- updating WebView (5).

**Next EMM to test** if TinyMDM fails: **ManageEngine MDM** (free tier up to
25 devices; Google-hosted private app tracks are documented). The alternative
is **Hexnode**, which documents a kiosk relaunch timer. No vendor I found
documents relaunch after a WebView update with the screen off. If the pilot
fails test 15 on TinyMDM, the fix probably belongs in LabourLink itself (a
scheduled self-check), not in a different EMM. That is a separate decision for
the owner.

---

## 2. Questions for TinyMDM support (send before any reset)

1. On a fully managed **non-Samsung** Android 13 device, does "Forbid the use of applications using their package name" disable or hide a **system** package with no launcher activity, such as `com.pri.morning.kill`? Is the hide re-applied after reboots and OS updates?
2. Can a policy install a **closed testing track** of a Play app that has been shared with our managed Google Play organisation ID? If yes, where is the track selected?
3. For an app delivered from the TinyMDM Store, are managed configurations read from the APK's own `app_restrictions.xml`?
4. In single-app kiosk, which Android lock-task features are enabled (`GLOBAL_ACTIONS`, `SYSTEM_INFO`, `NOTIFICATIONS`, `HOME`, `OVERVIEW`, `KEYGUARD`)? Does leaving "Disable device switch off" unticked keep the long-press Power menu?
5. Is **Android System WebView** (`com.google.android.webview`) updated by managed Play under update mode "Always"? Must it be allowed by package name first? Can app updates be limited to a time window?
6. If the kiosk app's process is killed, for example by a WebView update while the screen is off, does the TinyMDM agent relaunch it without the screen being turned on?
7. Is there any alert or report when the kiosk app is not running, or when a device has not checked in for N minutes?
8. Can USB debugging (ADB) be allowed on fully managed devices during a pilot?
9. Does TinyMDM use the Android Management API (Android Device Policy) or its own device-owner agent?
10. What happens to enrolled devices when a free trial ends without a subscription?

Record the answers in this file under section 1 before asking for reset approval.

---

## 3. Preparation (no phone needed, needs approval)

### 3.1 Version to pilot
- Proposed: **1.9.0, versionCode 15** (`web/android/app/build.gradle` on `feat/android-kiosk-pilot`).
  The highest versionCode in git on every branch is 14 (1.8.5), and Play installed 1.8.5 (14) on this phone on 2026-10-09.
  **Confirm 15 is unused in Play Console → App bundle explorer** (an upload never committed to git would take it). If it's taken, use the next free code. Play never accepts a reused code.
- Build on the signing machine from the merged or approved commit: `cd web && npm run android:aab`, signed with the existing upload key.

### 3.2 Getting LabourLink to the managed organisation (pick one after section 2)
**A. Closed testing track (preferred if TinyMDM supports track selection)**
1. TinyMDM → Enterprise Approved Apps → Register your company. Use a company Google account, not a personal one.
2. Copy the organisation ID (starts with `LC`) from the managed Google Play iframe → Admin settings.
3. Play Console → LabourLink → Test and release → Closed testing → *the pilot track* → Manage track → Testers → **Manage organizations** → add the ID ("TinyMDM pilot"). If that section is missing, first enable Advanced settings → Managed Google Play.
4. Upload 1.9.0 (15) to that track and roll it out **fully**. Testers only get full rollouts.
5. Check the schema problem: the kiosk keys only appear in TinyMDM if the **production** release contains them. If LabourLink has no production release, or it predates 1.9.0, use option B for the pilot.

**B. TinyMDM Store with a Play-signed APK (fallback)**
1. Upload the 1.9.0 (15) AAB to a closed track as above, but it doesn't need to be offered to organisations.
2. Play Console → App bundle explorer → 1.9.0 (15) → Downloads → **Signed, universal APK**. Its signature matches every Play install, so the phone can later move to Play without a reinstall.
3. TinyMDM → TinyMDM Store → upload that APK. Updates are then admin-triggered from the TinyMDM Store, not Play auto-updates. Record that limitation in the pilot report.

### 3.3 Maintenance PIN
1. On a trusted Mac: `node tools/android-kiosk/kiosk-credential-hash.mjs`. Type a **new** 8-12 digit PIN, not the test PIN used on the test phone.
2. Save the PIN in the company password manager as "LabourLink maintenance – Pilot Ulefone 1".
3. Paste only the printed `pbkdf2-sha256$…` line into TinyMDM. Never put the PIN itself in TinyMDM, chat, email or git.

### 3.4 Production touch (needs its own approval)
The Play or Store build talks to the **production** API. Pairing the pilot phone means approving it in desktop Setup → Devices and assigning an employee. Decide beforehand: a real crew member, or a production test employee that reports can exclude.

---

## 4. TinyMDM policy "LabourLink kiosk pilot"

Policies → Create a policy → assign the pilot user/group.

| Area | Setting | Value |
|---|---|---|
| Apps management | Default runtime permission | **Prompt** (default) |
| Apps management → LabourLink → Permissions | Notifications (`POST_NOTIFICATIONS`) | **Granted** (per-app grant; "notifications within application permissions" shipped 2026-04-22) |
| Apps management → LabourLink | Approve and install | yes (Play track or TinyMDM Store) |
| Apps management → LabourLink → Configuration | `kiosk_mode_enabled` | `true` |
| | `maintenance_credential` | the `pbkdf2-sha256$…` line from 3.3 |
| | `kiosk_device_label` | `Pilot Ulefone 1` |
| Apps management | **Enable Kiosk mode** (single app) | ticked, with LabourLink as the only installed lock-task app, set as **default application** |
| Kiosk options | Enable notifications / home button / recent tasks button | **unticked** |
| Kiosk options | Prevent access to the settings | **ticked** |
| Kiosk options | Disable device switch off | **unticked** (we want Power off / Restart) |
| Advanced lock task settings | Shake and quit (admin-code exit) | **ticked**, as the offline admin exit. Generate the admin code via "Show admin code" and store it with the PIN |
| Advanced apps management | Allow system apps by package name | `com.google.android.webview,com.google.android.gms,com.android.vending`, only if TinyMDM support says WebView needs allowing |
| Advanced apps management | Forbid apps by package name | `com.pri.morning.kill`, plus `com.google.android.apps.wellbeing` (see note) |
| Apps management | Default Play update mode | **Always** (Google prioritises updates). No app-update window exists in TinyMDM |
| Device-wide controls | OS update | **After midnight** (00:00-02:00) |
| Device-wide controls | Prevent adding Google accounts | ticked |
| Device-wide controls | Prevent factory reset | ticked (shows a temporary code when needed) |
| Device-wide controls | Google FRP | disabled for the pilot phone |
| Device-wide controls | Reporting frequency | most frequent offered |
| Screen control | Remove swipe to unlock | ticked (wake straight into LabourLink) |
| Wi-Fi Networks | New network | SSID `First Light`, its password; tick it in the policy's Wi-Fi configuration |
| Wi-Fi configuration | Restrict Wi-Fi to TinyMDM networks (Android 13) | **unticked** during the pilot, so the maintenance Wi-Fi path can still be tested |
| Developer options / USB debugging | allow | **pilot only**. Not documented in TinyMDM; see question 8 |

**Digital Wellbeing:** on the test phone it tried to suspend apps daily
(17:29, 17:35). Android refused for the device owner, and LabourLink was
never suspended. Forbidding it is safe for a single-purpose phone (it's only
a usage dashboard and bedtime mode). It isn't strictly necessary, so forbid
it only if TinyMDM's package-forbid works for system packages (requirement 1),
and confirm LabourLink is still `suspended=false` the next day.

---

## 5. Reset and enrolment checklist (each step needs the owner present)

**What the factory reset destroys** (all on the phone, nothing on a server):
- The test DPC (device owner), its kiosk policy, and the hidden state of `com.pri.morning.kill`, so the 03:01 killer is **back** until the EMM disables it.
- LabourLink QA build 1.9.0 (15) debug, its device identity `3142956a-…`, pairing to the fictional test employee on the local test server, kiosk prefs, and local SQLite (10 events, **0 pending**).
- **Updated Android System WebView 154** goes back to factory **111**. That's useful: the first managed-Play WebView update becomes test 15.
- Enlarged logcat buffer, Wi-Fi "First Light" credentials, all logs on the phone.
- Not affected: the evidence on the Mac (worktree and `.tgz`), the local test database, and production (the phone never talked to it).

Before:
1. LabourLink → Settings → Sync details: **Pending 0**. Last checked 2026-10-15 08:36: pending 0.
2. Save a final logcat and `dumpsys` snapshot to the evidence folder and refresh the `.tgz`.
3. Charge the phone above 50 %. Have the First Light password ready.
4. TinyMDM support answers recorded (section 2). The policy from section 4 is saved. LabourLink is approved/installed in it (Play track or TinyMDM Store).
5. Generate the fully managed QR in the TinyMDM console with the First Light Wi-Fi box ticked. QR codes expire after 24 h.

Reset (this removes the test DPC; the owner runs each command):
6. Undo the test DPC, then reset:
   ```sh
   adb -s 3112SH2010133658 shell am broadcast -n com.linklogictechnologies.kiosktestdpc/.CommandReceiver -a com.linklogictechnologies.kiosktestdpc.CLEAR_KIOSK
   adb -s 3112SH2010133658 shell am broadcast -n com.linklogictechnologies.kiosktestdpc/.CommandReceiver -a com.linklogictechnologies.kiosktestdpc.REMOVE_OWNER
   adb -s 3112SH2010133658 shell dpm list-owners   # expect: no owners
   ```
   `CLEAR_KIOSK` releases lock task and lifts the factory-reset, safe-boot and other restrictions. Then go to Settings → System → Reset options → Erase all data. If the phone is unresponsive, use recovery mode instead: power off, then hold **Power + Volume Up**.
7. On the first setup screen, tap **6 times** in one spot, wait, then scan the QR. Join First Light if asked. TinyMDM installs, then tap Begin and accept.
8. TinyMDM applies the policy and installs LabourLink, which opens locked.
9. LabourLink shows a pairing code. Approve it in production desktop Setup → Devices for the chosen employee (3.4).
10. Run section 6.

---

## 6. Pilot acceptance tests (after approval; tick each one, keep evidence)

| # | Test | Pass condition |
|---|---|---|
| 1 | QR enrolment and pairing | TinyMDM is device owner. LabourLink installs from the chosen channel, opens locked, pairs, and the identity shows in maintenance |
| 2 | Lock-task restrictions | `mLockTaskModeState=LOCKED`. Home, Recents, Back-out, notification shade, quick settings, Assistant, Settings, browser, Play, dialer and camera all blocked (same 22 attempts as the test-DPC run) |
| 3 | Power menu and maintenance PIN | Long-press Power shows Power off / Restart. 5-s hold → PIN. Wrong PIN is rejected with lockout. Right PIN shows version 1.9.0 (15), `Locked`, Pending 0. Exit for 30 min and re-enter. TinyMDM Shake-and-quit admin code works offline |
| 4 | Work flow | Start work, switch activity, break, Finish Work all reach the server with original times |
| 5 | NFC | Row and bin tags start and switch work. **Activity and action tags** only once that unmerged work ships; otherwise record "n/a in 1.9.0" |
| 6 | Recent Jobs | Shows the day's runs and clears after midnight |
| 7 | Offline | Wi-Fi off: actions queue (pending > 0). Back online: sync to 0 with original timestamps |
| 8 | Messages | Desktop message reaches the phone within ~1 min (push within seconds) as a full-screen alert with sound and vibration. Acknowledge works |
| 9 | Reboot | Power → Restart. Back locked in LabourLink with no PIN and the same identity |
| 10 | Wi-Fi maintenance | Maintenance → Wi-Fi settings → change network → Back. It relocks by itself |
| 11 | Midnight cutoff | Shift open across midnight. In the morning the phone shows "not working", and the server entry ends at exactly 00:00:00 (production hourly cron) |
| 12 | Overnight survival | Same LabourLink PID before bed and in the morning. No kill at 03:01. `com.pri.morning.kill` disabled. Still `LOCKED` |
| 13 | Battery | Full shift on battery; record % used (test-DPC baseline: 0 % over a 15 h idle night) |
| 14 | Managed update with pending events | Queue events offline, then deliver 1.9.0 (16) through the chosen channel. After the update: same identity, still locked, pending events kept and synced. Relaunched by `KioskRelaunchReceiver` |
| 15 | **WebView update while locked (hard requirement)** | Phone locked in LabourLink, **screen off, nobody touches it**, WebView still factory 111. Let managed Play update it (or trigger the update from the EMM). Pass only if: `ActivityManager` logs the kill `due to installPackageLI`, **and** a new LabourLink `am_proc_start` follows within a few minutes **without** a `screen_toggled 1` in between, **and** afterwards it is `LOCKED`, same identity, pending events unchanged. Evidence: logcat around the update and `ps` STIME before/after. Fail (as on 2026-10-13): LabourLink only returns when someone wakes the screen |

Pilot outcome:
- **Go:** all 15 pass, and requirements 1-5 are confirmed in section 1.
- **No-go on test 15:** stop the rollout. Owner decides between an in-app self-relaunch and the next EMM.

---

## 7. Heartbeat (recommended regardless of EMM)

TinyMDM has no documented "app not running" alert. LabourLink already polls
`/api/mobile/messages/outstanding` every 60 s while the app is alive and
online. A server-side check could flag any kiosk device silent for more than
N minutes during working hours, as a desktop banner and/or email. It doesn't
depend on the EMM. It catches a dead app and a dead phone alike, and it can't
hide a failure, because it only reports. This is not built: it's a separate
feature for the owner to approve.

---

## 8. Rollback and recovery

| Situation | Action |
|---|---|
| Enrolment fails part-way | TinyMDM retry screen, or recovery-mode factory reset (Power + Volume Up) and start section 5 again |
| Pilot rejected, phone back to normal | Pending 0 → desktop: unassign the device → TinyMDM: delete/wipe the device (factory reset for fully managed) → set up normally |
| Need the phone out of kiosk briefly | Maintenance PIN → exit for 30 min, **or** TinyMDM Shake and quit + admin code (offline), **or** console: Devices → disable kiosk (online) |
| LabourLink won't start | Native "LabourLink couldn't start" screen → hold title 5 s → maintenance → Restart. Or Power → Restart. Never "clear data" in TinyMDM: it deletes the identity and pending work |
| Bad LabourLink build | Halt the Play rollout, or stop the TinyMDM Store push. Fix forward with a higher versionCode. Play can't downgrade |
| TinyMDM trial ends without purchase | What happens to enrolled devices after day 30 isn't documented. Ask support (section 2), and wipe and return the phone to normal before day 30 unless the owner has approved a purchase |
| Back to the test-DPC setup | Factory reset, then re-run the test-DPC commands in `README.md` (emulator section) on the phone with owner approval |

Kiosk code is inert without the EMM's managed configuration, so personal
installs from the same Play build are unaffected throughout.

## 9. Cost (TinyMDM pricing page, 2026-10-15)
- Free trial: **30 days, up to 10 devices, all features, no credit card.**
- Classic **€21.20 / device / year**. Flexible **€2.12 / device / month**. Custom by quote. Billed in EUR, USD, CAD or GBP. All features in every plan; kiosk features need Kiosk (COSU) mode. "All sales are final."
- The pilot fits inside the trial. Nothing is purchased without owner approval.
