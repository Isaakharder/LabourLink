# LabourLink iOS — real-iPhone checks before external TestFlight

Run on a physical iPhone (iPhone 7 or later for NFC) with the TestFlight build
(1.8.5, build 14 or later). Use only fictional data: a test employee on
production created for this purpose, or the demo instance via a reviewer code.

Already verified in the iOS simulator against local servers (not production):
normal pairing, reviewer pairing + demo routing across restarts, offline start
and sync after an app kill, APNs token registration, notification display and
tap-to-open, privacy link, NFC "no hardware" handling, backup exclusion flags.
The checks below need real hardware, real APNs, or the live servers.

## Before installing

- [ ] Server branch `server/ios-apns-push` deployed to the production API and
      `npm run migrate:production` applied (migration 059).
- [ ] Railway production API: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` set.
- [ ] Railway demo API: `CORS_ORIGIN` includes `capacitor://localhost`
      (it currently allows only the Android origin).
- [ ] Updated `privacy.html` deployed with the web service.

## Pairing

- [ ] Fresh install shows the pairing code below the status bar / Dynamic Island.
- [ ] Admin approves the code on the desktop Setup page; the phone switches to Home
      within a few seconds and shows the right employee.
- [ ] Force-quit and reopen: still paired, same employee.

## Reviewer access (demo)

- [ ] Fresh install → "Have an access code?" → reviewer code → paired as a
      "Demo Reviewer" with the demo welcome message.
- [ ] Start a job, force-quit, reopen: still on the demo; nothing appears in production.
- [ ] Settings shows the demo employee; there is no way back to production on that install.

## PIN login (web only)

The native app has no PIN screen (phones are trusted through pairing). On the
iPhone, check the web app in Safari instead:

- [ ] labourlink.lltech.io → sign in with email + PIN → stays signed in after reload.
- [ ] A wrong PIN is rejected with a clear message.

## Offline and reconnect

- [ ] Airplane mode on → start a job, start/end a break, switch job: each shows
      "pending sync"; the timer keeps running.
- [ ] Force-quit while offline, reopen: the work state and pending count are unchanged.
- [ ] Airplane mode off: everything syncs within about 30 seconds and appears on
      the desktop Inputs page with the correct times.

## NFC (registered Ridder tags and LabourLink-written tags)

- [ ] Home while working a row job: tapping **Scan** opens Apple's scan sheet; a
      registered row tag switches the row; the sheet closes after one tag.
- [ ] Cancel the sheet → "Scan cancelled."; wait it out → "Scan timed out — tap Scan again".
- [ ] Bin/carrier tag on a Picking job selects the cart.
- [ ] Unregistered tag → "That tag isn't registered. Choose manually below."
- [ ] Admin: Register Existing Tag (row) → scan → saved → returns to the same
      phase and scroll position with the row highlighted.
- [ ] Admin: Write New Tag → scan a blank tag → write → verify scan succeeds.
      KNOWN ISSUE (1.8.5 build 14): expected to fail on iPhone with "No active NFC
      session or tag" — the iOS scan session closes after the first read, so the
      plugin has no tag left to write to. Fix planned for the next build.
- [ ] NFC Diagnostic shows the tag ID, type and NDEF records.
- [ ] Xcode console (filter `[nfc-swift]`) shows a non-empty identifier for Ridder tags.

## Notifications (needs APNs credentials on the server)

- [ ] Settings → Enable notifications → iOS prompt → Allow → "Notifications are
      enabled on this device."
- [ ] Desktop Messages → send to this employee with the app in the background:
      banner "LabourLink — You have a new message…" arrives.
- [ ] Tap the banner: the app opens and shows the message overlay.
- [ ] With the app closed (swiped away): the banner still arrives.
- [ ] Production registration row has `platform = 'ios_apns'` and
      `apns_environment = 'production'` after the first send.

## Privacy and general

- [ ] Settings → Privacy Policy and the pairing screen's link open the live policy
      in Safari; it mentions iPhone and Apple Push Notification service.
- [ ] Launch screen: white with the blue "LabourLink" wordmark, no flash into the app.
- [ ] Home screen icon is the real LabourLink icon (not the Capacitor placeholder).
- [ ] Portrait and landscape both lay out correctly; Dynamic Island devices
      don't hide content.
