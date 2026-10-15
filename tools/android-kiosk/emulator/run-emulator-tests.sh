#!/usr/bin/env bash
# TEST ONLY — LabourLink Android kiosk emulator suite.
#
# Preconditions (see ../README.md, "Emulator suite"):
#   - an emulator (never a physical phone) at $SERIAL, booted, no accounts
#   - the local API running on http://localhost:4000 (throwaway DB)
#   - LabourLink QA-emulator debug APK installed and PAIRED, with work started
#   - kiosk-test-dpc installed as device owner and APPLY_KIOSK applied with
#     the credential for $PIN
#
# Each check prints PASS/FAIL; the script exits non-zero if any failed.
set -uo pipefail

SERIAL="${SERIAL:-emulator-5554}"
case "$SERIAL" in emulator-*) ;; *) echo "refusing: $SERIAL is not an emulator" >&2; exit 2 ;; esac

DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$(cd "$DIR/.." && pwd)"
APK="${APK:-$TOOLS/../../web/android/app/build/outputs/apk/debug/app-debug.apk}"
PKG=com.linklogictechnologies.labourlink
DPC=com.linklogictechnologies.kiosktestdpc
PIN="${PIN:-482913}"
UI="$DIR/ui.sh"
export SERIAL

PASSED=0
FAILED=0
FAILS=()

e() { adb -s "$SERIAL" "$@"; }
log() { printf '\n=== %s\n' "$*"; }
pass() { PASSED=$((PASSED + 1)); echo "PASS  $1"; }
fail() { FAILED=$((FAILED + 1)); FAILS+=("$1"); echo "FAIL  $1${2:+ ($2)}"; }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }

lock_state() { e shell dumpsys activity activities | grep -m1 mLockTaskModeState | sed 's/.*=//' | tr -d '\r '; }
top_activity() { e shell dumpsys activity activities | grep -m1 topResumedActivity | grep -o 'u0 [^ }]*' | sed 's/u0 //'; }
top_is_labourlink() { [[ "$(top_activity)" == "$PKG/"* ]]; }
is_locked() { [[ "$(lock_state)" == "LOCKED" ]]; }
in_kiosk() { top_is_labourlink && is_locked; }
not_locked() { [[ "$(lock_state)" == "NONE" ]]; }

wait_for() { # wait_for <seconds> <cmd...>
  local t="$1"; shift
  for ((i = 0; i < t; i++)); do "$@" && return 0; sleep 1; done
  return 1
}

dpc() { # dpc <ACTION> [extras...]
  e shell am broadcast -n "$DPC/.CommandReceiver" -a "$DPC.$1" "${@:2}" | grep -o 'data="[^"]*"'
}

web() { "$UI" eval "$1" 2>/dev/null; }
web_text() { "$UI" text 2>/dev/null; }
web_click() { "$UI" click "$1" >/dev/null 2>&1; }
web_has() { web_text | grep -qF "$1"; }
device_id() { web 'localStorage.getItem("labourlink_device_identifier")'; }
PENDING_JS=$(cat <<'JS'
(async () => {
  // Same query as localEventStore.getPendingCount.
  const id = localStorage.getItem("labourlink_device_identifier");
  const r = await Capacitor.Plugins.CapacitorSQLite.query({
    database: "labourlink_events",
    statement: "select count(*) as n from pending_events where device_id = ? and sync_status in ('pending', 'syncing')",
    values: [id],
    readonly: false,
  });
  return String(r.values[0].n);
})()
JS
)
pending_count() { web "$PENDING_JS"; }
pending_is() { [[ "$(pending_count)" == "$1" ]]; }
pending_positive() { local n; n="$(pending_count)"; [[ "$n" =~ ^[0-9]+$ ]] && ((n > 0)); }
identity_is() { [[ "$(device_id)" == "$1" ]]; }
top_contains() { [[ "$(top_activity)" == *"$1"* ]]; }
kiosk_device_reported() { [[ "$(web 'Capacitor.Plugins.LabourLinkKiosk.getStatus().then(s => String(s.kioskDevice))')" == "$1" ]]; }
focus_is_shade() { e shell dumpsys window | grep -m1 mCurrentFocus | grep -q NotificationShade; }
power_menu_showing() { e shell dumpsys window | grep -qiE 'GlobalActions|ActionsDialog'; }
kiosk_notice_shown() { web 'document.querySelector(".kiosk-notice")?.innerText ?? ""' | grep -q 'opened on this phone'; }
alert_logged() { e logcat -d -s LabourLinkKiosk | grep -q 'message alert'; }
booted() { [[ "$(e shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; }

# --- native (maintenance screen) UI helpers via uiautomator -----------------
dump_ui() { e shell uiautomator dump /sdcard/ll-ui.xml >/dev/null 2>&1; e shell cat /sdcard/ll-ui.xml; }
scroll_top() { e shell input swipe 540 700 540 1900 200; e shell input swipe 540 700 540 1900 200; sleep 0.4; }
native_has() { # looks on screen first; only then scrolls (a swipe outside a dialog would dismiss it)
  local tries
  dump_ui | grep -qF "$1" && return 0
  scroll_top
  for tries in 1 2 3; do
    dump_ui | grep -qF "$1" && return 0
    e shell input swipe 540 1700 540 700 300; sleep 0.5
  done
  return 1
}
native_tap() { # native_tap "<exact text>" — scrolls down to find it if needed
  local xy tries
  xy=$(native_find "$1")
  [[ -n "$xy" ]] && { e shell input tap $xy; return 0; }
  scroll_top
  for tries in 1 2 3 4; do
    xy=$(native_find "$1")
    [[ -n "$xy" ]] && { e shell input tap $xy; return 0; }
    e shell input swipe 540 1700 540 700 300; sleep 0.5
  done
  return 1
}
native_find() {
  local xy
  xy=$(dump_ui | python3 -c '
import re, sys
xml = sys.stdin.read(); want = sys.argv[1].lower()
for m in re.finditer(r"<node [^>]*>", xml):
    n = m.group(0)
    t = re.search(r" text=\"([^\"]*)\"", n)
    # Case-insensitive: dialog buttons render their labels in caps.
    if t and t.group(1).lower() == want:
        b = re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", n)
        x1, y1, x2, y2 = map(int, b.groups()); print((x1 + x2) // 2, (y1 + y2) // 2); break
' "$1")
  echo "$xy"
}
native_type_pin() { # focuses the first EditText and types
  local xy
  xy=$(dump_ui | python3 -c '
import re, sys
xml = sys.stdin.read()
for m in re.finditer(r"<node [^>]*class=\"android.widget.EditText\"[^>]*>", xml):
    b = re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", m.group(0))
    x1, y1, x2, y2 = map(int, b.groups()); print((x1 + x2) // 2, (y1 + y2) // 2); break
')
  [[ -n "$xy" ]] || return 1
  e shell input tap $xy
  sleep 0.5
  e shell input text "$1"
}
maintenance_on_top() { [[ "$(top_activity)" == "$PKG/.kiosk.MaintenanceActivity" ]]; }

open_maintenance() { # real 5.5 s press-and-hold on the Settings heading
  web_click "Settings"
  sleep 1.5
  local xy
  # CSS px -> screen px: the WebView sits inside the system-bar insets, so
  # offset by its on-screen origin (from the accessibility tree).
  local origin css
  origin=$(dump_ui | grep -o 'class="android.webkit.WebView"[^>]*bounds="\[[0-9]*,[0-9]*\]' | head -1 | sed -E 's/.*bounds="\[([0-9]+),([0-9]+)\]/\1 \2/')
  css=$(web '(() => { const el = document.querySelector(".kiosk-hold"); if (!el) return ""; const r = el.getBoundingClientRect(); return (r.left + r.width / 2) * devicePixelRatio + " " + (r.top + r.height / 2) * devicePixelRatio; })()')
  [[ -n "$css" && -n "$origin" ]] || return 1
  xy=$(python3 -c 'import sys; ox, oy, cx, cy = map(float, sys.argv[1:]); print(round(ox + cx), round(oy + cy))' $origin $css)
  e shell input swipe $xy $xy 5600
  wait_for 5 maintenance_on_top
}

unlock_maintenance() { # unlock_maintenance <pin>
  native_type_pin "$1" && native_tap "Unlock" && wait_for 10 native_has "Restart LabourLink"
}

close_maintenance() { native_tap "Close" >/dev/null 2>&1; sleep 1; }

go_home_tab() { web_click "Home"; sleep 1; }

# ============================================================================
log "0. Preconditions"
# Pixel emulator images map long-press power to the Assistant by default;
# the Ulefone (and the kiosk policy's intent) is the power/restart menu.
e shell settings put global power_button_long_press 1
# Start every run from the same maintenance state. A previous run leaves
# the console credential rotated (2f), maybe a local PIN, and, if it failed,
# an escalated brute-force lockout, all in LabourLink's kiosk prefs. Clear
# those prefs (debug build: run-as), push $PIN's credential, and restart
# LabourLink so it re-reads both. Identity and the event queue live
# elsewhere and are untouched.
e shell run-as "$PKG" rm -f shared_prefs/labourlink_kiosk.xml
dpc SET_CONFIG --es credential "'$(echo "$PIN" | node "$TOOLS/kiosk-credential-hash.mjs" 2>/dev/null)'" >/dev/null
e shell am force-stop "$PKG"; e shell input keyevent KEYCODE_HOME
wait_for 30 in_kiosk || { echo "precondition: LabourLink did not come back locked after the reset" >&2; exit 2; }
sleep 6
# Section 4 needs a running shift to queue a break and switch against. A
# shift left over from an earlier day is closed at local midnight, so stop
# here with a clear message rather than failing halfway through.
if ! wait_for 20 web_has "Working"; then
  echo "precondition: start a job on the emulator first (the app shows 'Not working')" >&2
  exit 2
fi
check "LabourLink in front and in true lock task mode (not pinning)" in_kiosk
check "native plugin reports an enrolled kiosk device" kiosk_device_reported true
DEVICE_ID="$(device_id)"
echo "device identity: $DEVICE_ID"
check "device is paired (identity present)" test -n "$DEVICE_ID"

# ============================================================================
log "1. Escape attempts"
e shell input keyevent KEYCODE_HOME; sleep 1.5
check "Home button does not leave LabourLink" in_kiosk
e shell input keyevent KEYCODE_APP_SWITCH; sleep 1.5
check "Recents button does not leave LabourLink" in_kiosk
for _ in 1 2 3 4 5 6; do e shell input keyevent KEYCODE_BACK; sleep 0.4; done; sleep 1
check "Back x6 does not leave LabourLink" in_kiosk
for intent in "-a android.settings.SETTINGS" "-n com.android.settings/.Settings" "-a android.settings.WIFI_SETTINGS" \
  "-a android.intent.action.VIEW -d https://example.com" "-a android.intent.action.VIEW -d market://details?id=com.android.chrome" \
  "-a android.intent.action.DIAL -d tel:123" "-a android.intent.action.MAIN -c android.intent.category.HOME"; do
  # shellcheck disable=SC2086
  e shell am start $intent >/dev/null 2>&1; sleep 1.5
  check "intent [$intent] cannot escape" in_kiosk
done
e shell cmd statusbar expand-notifications; sleep 1
! focus_is_shade && pass "notification shade cannot be expanded (focus check)" || fail "notification shade cannot be expanded (focus check)"
e shell cmd statusbar collapse
e shell input swipe 540 2 540 1400 250; sleep 1
check "swipe down from the top does not open the shade" in_kiosk
e shell input swipe 540 2390 540 1200 250; sleep 1
check "swipe up from the bottom (gesture home) does not leave" in_kiosk

log "1b. External link inside LabourLink"
web_click "Settings"; sleep 1
web_click "Privacy Policy"; sleep 1.5
check "external link blocked, explanation shown" kiosk_notice_shown
check "still in kiosk after external link" in_kiosk
go_home_tab

log "1c. Power menu stays available"
e shell input keyevent --longpress KEYCODE_POWER; sleep 2
check "long-press power shows the power/restart menu" power_menu_showing
e shell input keyevent KEYCODE_BACK; sleep 1
check "back in kiosk after dismissing the power menu" in_kiosk

# ============================================================================
log "2. Hidden maintenance entry"
check "5-second hold opens the maintenance screen" open_maintenance
native_has "Device identity" && fail "maintenance shows nothing before authentication" || pass "maintenance shows nothing before authentication"
native_type_pin "000000"; native_tap "Unlock"; sleep 4
check "wrong PIN rejected" native_has "Incorrect PIN."
check "correct PIN unlocks (offline-capable local check)" unlock_maintenance "$PIN"
check "maintenance shows the device identity" native_has "Device identity: $DEVICE_ID"
check "maintenance shows the pending-event count" native_has "Pending events:"
check "maintenance shows app version/build" native_has "App version: "
check "maintenance screen is still inside lock task" is_locked

log "2b. Temporary kiosk exit and re-entry"
native_tap "Exit kiosk for 30 minutes"; sleep 1; native_tap "Continue"; sleep 2
check "kiosk exit leaves lock task mode" wait_for 5 not_locked
e shell am start -a android.settings.SETTINGS >/dev/null 2>&1; sleep 2
check "during maintenance Settings is reachable" top_contains com.android.settings
e shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1; sleep 2
check "maintenance exit persists across app resume (no surprise relock)" not_locked
check "re-open maintenance during exit" open_maintenance
unlock_maintenance "$PIN" >/dev/null
native_tap "Re-enter kiosk mode"; sleep 2
check "re-enter kiosk restores lock task mode" wait_for 5 is_locked
close_maintenance
check "back in LabourLink, locked" in_kiosk

log "2c. Screen off ends a maintenance exit"
open_maintenance >/dev/null && unlock_maintenance "$PIN" >/dev/null
native_tap "Exit kiosk for 30 minutes"; sleep 1; native_tap "Continue"; sleep 2
check "(exit active)" not_locked
close_maintenance
e shell input keyevent KEYCODE_SLEEP; sleep 3
e shell input keyevent KEYCODE_WAKEUP; sleep 3
check "screen wakes without a PIN, straight into LabourLink" top_is_labourlink
check "screen-off ended the maintenance exit (relocked on wake)" wait_for 5 is_locked

log "2d. Controlled Wi-Fi path"
open_maintenance >/dev/null && unlock_maintenance "$PIN" >/dev/null
native_tap "Wi-Fi settings"; sleep 3
check "Wi-Fi panel opens (temporary authenticated unlock)" top_contains settings
e shell input keyevent KEYCODE_BACK; sleep 3
check "returning from Wi-Fi lands on maintenance" maintenance_on_top
check "returning from Wi-Fi relocks immediately" is_locked
close_maintenance

log "2e. Restart LabourLink from maintenance"
open_maintenance >/dev/null && unlock_maintenance "$PIN" >/dev/null
native_tap "Restart LabourLink"; sleep 8
check "restart returns to LabourLink, locked" in_kiosk
check "restart kept the device identity" wait_for 30 identity_is "$DEVICE_ID"

log "2f. Credential rotation"
NEWPIN=13572468
open_maintenance >/dev/null && unlock_maintenance "$PIN" >/dev/null
native_tap "Change maintenance PIN"; sleep 1
xy=$(dump_ui | python3 -c '
import re,sys
xml=sys.stdin.read()
for m in re.finditer(r"<node [^>]*class=\"android.widget.EditText\"[^>]*>", xml):
    b=re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", m.group(0)); x1,y1,x2,y2=map(int,b.groups()); print((x1+x2)//2,(y1+y2)//2)
')
first=$(echo "$xy" | sed -n 1p); second=$(echo "$xy" | sed -n 2p)
e shell input tap $first; e shell input text "$NEWPIN"; e shell input tap $second; e shell input text "$NEWPIN"
native_tap "Save"; sleep 5
check "local PIN change saved" native_has "Restart LabourLink"
close_maintenance
open_maintenance >/dev/null
native_type_pin "$PIN"; native_tap "Unlock"; sleep 4
check "old PIN no longer works after local rotation" native_has "Incorrect PIN."
check "new local PIN works" unlock_maintenance "$NEWPIN"
close_maintenance
CONSOLE_PIN=24681357
CONSOLE_CRED=$(echo "$CONSOLE_PIN" | node "$TOOLS/kiosk-credential-hash.mjs" 2>/dev/null)
dpc SET_CONFIG --es credential "'$CONSOLE_CRED'" >/dev/null; sleep 2
open_maintenance >/dev/null
native_type_pin "$NEWPIN"; native_tap "Unlock"; sleep 4
check "console (EMM) credential change overrides a forgotten local PIN" native_has "Incorrect PIN."
check "console PIN works" unlock_maintenance "$CONSOLE_PIN"
close_maintenance
PIN=$CONSOLE_PIN

log "2g. Brute-force lockout"
open_maintenance >/dev/null
for _ in 1 2 3 4 5; do native_type_pin "111111"; native_tap "Unlock"; sleep 3.5; done
check "five wrong PINs lock maintenance out" native_has "Too many incorrect attempts"
close_maintenance
echo "(waiting out the 30 s lockout)"; sleep 32
# A successful unlock clears the failure counter, so a later run starts clean.
open_maintenance >/dev/null
check "correct PIN works again once the lockout expires" unlock_maintenance "$PIN"
close_maintenance

# ============================================================================
log "3. Messages while continuously foregrounded"
go_home_tab
e logcat -c
node "$DIR/local-server.mjs" send-message "Kiosk test: please come to the packhouse" >/dev/null
check "message overlay appears within 75 s with no app switch/resume" wait_for 75 web_has "Kiosk test: please come to the packhouse"
check "sound/vibration alert fired" alert_logged
check "still in kiosk with the message showing" in_kiosk
web_click "Acknowledge"; sleep 3
web_has "Kiosk test: please come to the packhouse" && fail "message acknowledged and dismissed" || pass "message acknowledged and dismissed"

# ============================================================================
log "4. Offline work: break, switch, reboot, crash, update — then sync"
e shell cmd connectivity airplane-mode enable; sleep 4
web_click "Start Break"; sleep 2
web_click "End Break"; sleep 2
web_click "Winding & Pruning" >/dev/null 2>&1 || true
P1=$(pending_count); echo "pending while offline: $P1"
check "offline actions queued locally" pending_positive

e shell reboot; sleep 8
wait_for 120 booted
check "reboot returns directly to LabourLink in kiosk" wait_for 60 in_kiosk
sleep 6
check "identity survives reboot" wait_for 30 identity_is "$DEVICE_ID"
check "offline queue survives reboot" wait_for 30 pending_is "$P1"

e shell am crash "$PKG" >/dev/null 2>&1; sleep 10
check "app crash recovers into LabourLink kiosk" wait_for 30 in_kiosk
sleep 4
check "offline queue survives crash" wait_for 30 pending_is "$P1"

node "$DIR/cdp.mjs" "$SERIAL" navigate "chrome://crash" >/dev/null 2>&1; sleep 12
check "WebView renderer crash recovers in place, still locked" wait_for 30 in_kiosk
check "app UI is back after renderer crash" wait_for 20 web_has "Settings"

e shell am force-stop "$PKG"; sleep 1
e shell input keyevent KEYCODE_HOME; sleep 6
check "force-stopped app is relaunched by the kiosk launcher" wait_for 20 in_kiosk

e install -r "$APK" >/dev/null; sleep 12
check "app update while offline work is pending returns to kiosk" wait_for 30 in_kiosk
sleep 4
check "offline queue survives app update" wait_for 30 pending_is "$P1"
check "identity survives app update" wait_for 30 identity_is "$DEVICE_ID"

e shell cmd connectivity airplane-mode disable
check "Wi-Fi recovery: queue drains to the server" wait_for 120 pending_is 0
check "still locked after sync" in_kiosk

# ============================================================================
echo
echo "Passed: $PASSED  Failed: $FAILED"
for f in ${FAILS[@]+"${FAILS[@]}"}; do echo "  - $f"; done  # bash 3.2: empty array + set -u
[[ $FAILED -eq 0 ]]
