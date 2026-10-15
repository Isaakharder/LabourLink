#!/usr/bin/env bash
# TEST ONLY — rehearses "remove kiosk management" on the emulator and proves
# the SAME LabourLink install then behaves like a regular personal install:
# no lock task, Home leaves the app, external links open normally, kiosk
# plugin reports not-kiosk, identity/pairing intact.
set -uo pipefail
SERIAL="${SERIAL:-emulator-5554}"
case "$SERIAL" in emulator-*) ;; *) echo "refusing: $SERIAL is not an emulator" >&2; exit 2 ;; esac
DIR="$(cd "$(dirname "$0")" && pwd)"
PKG=com.linklogictechnologies.labourlink
DPC=com.linklogictechnologies.kiosktestdpc
UI="$DIR/ui.sh"
export SERIAL

PASSED=0; FAILED=0; FAILS=()
e() { adb -s "$SERIAL" "$@"; }
pass() { PASSED=$((PASSED + 1)); echo "PASS  $1"; }
fail() { FAILED=$((FAILED + 1)); FAILS+=("$1"); echo "FAIL  $1"; }
check() { local n="$1"; shift; if "$@"; then pass "$n"; else fail "$n"; fi; }
lock_state() { e shell dumpsys activity activities | grep -m1 mLockTaskModeState | sed 's/.*=//' | tr -d '\r '; }
top_activity() { e shell dumpsys activity activities | grep -m1 topResumedActivity | grep -o 'u0 [^ }]*' | sed 's/u0 //'; }
not_locked() { [[ "$(lock_state)" == "NONE" ]]; }
top_is_labourlink() { [[ "$(top_activity)" == "$PKG/"* ]]; }
top_not_labourlink() { ! top_is_labourlink; }
wait_for() { local t="$1"; shift; for ((i = 0; i < t; i++)); do "$@" && return 0; sleep 1; done; return 1; }
web() { "$UI" eval "$1" 2>/dev/null; }
kiosk_reported() { [[ "$(web 'Capacitor.Plugins.LabourLinkKiosk.getStatus().then(s => String(s.kioskDevice))')" == "$1" ]]; }

ID_BEFORE="$(web 'localStorage.getItem("labourlink_device_identifier")')"
echo "identity before: $ID_BEFORE"

echo "=== Remove kiosk policy (EMM: kiosk off / move to non-kiosk policy)"
e shell am broadcast -n "$DPC/.CommandReceiver" -a "$DPC.CLEAR_KIOSK" | grep -o 'data="[^"]*"'
check "lock task released when LabourLink is removed from the allowlist" wait_for 10 not_locked
check "kiosk plugin now reports not-kiosk (live, no restart)" wait_for 10 kiosk_reported false
check "maintenance hold is gone (no wrapper rendered)" bash -c "[[ \$('$UI' eval 'String(!!document.querySelector(\".kiosk-hold\"))' 2>/dev/null) == false ]]"

echo "=== Remove device owner (EMM retire; on a real phone this is a wipe)"
e shell am broadcast -n "$DPC/.CommandReceiver" -a "$DPC.REMOVE_OWNER" | grep -o 'data="[^"]*"'
check "no device owner left" bash -c "adb -s $SERIAL shell dpm list-owners 2>&1 | grep -q 'no owners'"
e shell pm uninstall "$DPC" >/dev/null

echo "=== Regular Android behaviour"
e shell am start -n "$PKG/.MainActivity" >/dev/null; sleep 4
check "LabourLink opens normally" top_is_labourlink
check "not locked" not_locked
e shell input keyevent KEYCODE_HOME; sleep 2
check "Home leaves LabourLink like any normal app" top_not_labourlink
e shell am start -n "$PKG/.MainActivity" >/dev/null; sleep 4
"$UI" click "Settings" >/dev/null 2>&1; sleep 1
"$UI" click "Privacy Policy" >/dev/null 2>&1; sleep 3
check "external link leaves the app (browser), as before" top_not_labourlink
e shell am start -n "$PKG/.MainActivity" >/dev/null; sleep 4
check "identity and pairing unchanged" bash -c "[[ \$('$UI' eval 'localStorage.getItem(\"labourlink_device_identifier\")' 2>/dev/null) == '$ID_BEFORE' ]]"
check "still paired (home screen, not pairing screen)" bash -c "'$UI' text 2>/dev/null | grep -qE 'Working|Not working|On break'"

echo
echo "Passed: $PASSED  Failed: $FAILED"
for f in "${FAILS[@]}"; do echo "  - $f"; done
[[ $FAILED -eq 0 ]]
