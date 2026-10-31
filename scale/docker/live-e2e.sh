#!/bin/sh
# End-to-end check of LIVE mode against a real LabourLink server (a local
# test server, never production): Register Bins, a phone bin choice through
# the server's real phone-sync route, a weighing credited from it, and the
# duplicate guard.
#
# The real labourlink-scaled binary runs in live mode on socat pseudo
# terminals named like the NUC's devices. The server must already be running
# on the host, against a throwaway database seeded with: a scale station
# (its token), a user with email + PIN, a bin with no tag, and a paired phone
# whose employee has a Job with a "Which bin?" question. Those come in as a
# JSON file (see server/src/scripts on the scale branches for the seed used).
#
#   docker run --rm -v "$PWD":/work -v /path/to/e2e.json:/e2e/e2e.json \
#     -v llscale-cargo:/usr/local/cargo/registry -v llscale-test-target:/cache/target \
#     -e CARGO_TARGET_DIR=/cache/target -e E2E_SERVER=host.docker.internal:4050 \
#     labourlink-scale-hwtest sh /work/scale/docker/live-e2e.sh
set -eu
E=/e2e/e2e.json
SERVER=${E2E_SERVER:?set E2E_SERVER to host:port of the test server}
BIN=${CARGO_TARGET_DIR:-/work/scale/service/target}/debug/labourlink-scaled
cd /work/scale/service && cargo build -q --offline
j() { jq -r "$1" "$E"; }
T=/tmp/live && rm -rf $T && mkdir -p $T/dev/serial/by-id $T/dev/labourlink $T/data
SCALE=$T/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_BG0427FU-if00-port0
RFID=$T/dev/labourlink/rfid
socat pty,raw,echo=0,link=$T/scale-feed pty,raw,echo=0,link=$SCALE &
socat pty,raw,echo=0,link=$T/rfid-feed pty,raw,echo=0,link=$RFID &
# The station only accepts plain http for a loopback server.
socat TCP-LISTEN:4050,bind=127.0.0.1,fork,reuseaddr TCP:$SERVER &
sleep 1
printf "%s" "$(j .token)" > $T/station-token
TAG=$(j .tag)
cat > $T/config.json <<EOF
{
  "mode": "live",
  "stationName": "Live e2e",
  "dataDir": "$T/data",
  "apiBaseUrl": "http://127.0.0.1:4050",
  "stationTokenFile": "$T/station-token",
  "scale": { "port": "$SCALE", "baud": 9600, "protocol": "rinstrum-auto-a" },
  "rfid": { "port": "$RFID", "baud": 9600 }
}
EOF
$BIN --config $T/config.json > $T/service.log 2>&1 &
SVC=$!
L=http://127.0.0.1:47800
state() { curl -s $L/api/state; }
fail() { echo "FAIL: $1"; echo "--- state"; state | jq -c '{phase, registration, recent: [.recent[] | {carrierName, netG, assignmentStatus, employeeName, creditsLive}], connections}'; echo "--- log"; cat $T/service.log; exit 1; }
frames() { n=$(( $2 * 10 )); while [ $n -gt 0 ]; do printf '\002%s\003' "$1" > $T/scale-feed; sleep 0.1; n=$((n - 1)); done; }
tag() { printf 'R 0000 %s\r\n' "$1" > $T/rfid-feed; }
waitfor() { n=0; until [ "$(state | jq -r "$1")" = "$2" ]; do n=$((n + 1)); [ $n -gt 100 ] && fail "timed out waiting for $1 = $2"; sleep 0.2; done; }

echo "== 0. live mode reaches the server; credits are off (trial)"
frames '     0.0G' 2
waitfor .connections.server.state online
waitfor .creditsEnabled false

echo "== 1. Register Bins: sign in, measure an empty bin, register it"
S=$(curl -s -X POST -H 'content-type: application/json' -d "{\"email\":\"$(j .email)\",\"pin\":\"$(j .pin)\"}" $L/api/session/login | jq -r .token)
[ -n "$S" ] && [ "$S" != null ] || fail "sign-in"
H="x-session-token: $S"
curl -s -X POST -H "$H" $L/api/register/start > /dev/null
frames '     0.0G' 3
waitfor .registration.phase.phase ready
tag "$TAG"
frames '   154.4G' 13
waitfor .registration.phase.phase proposed
[ "$(state | jq -r .registration.phase.proposal.grossG)" = 154400 ] || fail "proposed tare"
[ "$(curl -s -H "$H" $L/api/register/tag-owner | jq -r .bin)" = null ] || fail "tag owner"
BINID=$(curl -s -H "$H" "$L/api/register/bins?q=$(j .binNumber)" | jq -r '.bins[0].id')
[ "$BINID" = "$(j .carrierId)" ] || fail "bin lookup by number"
C="{\"carrierId\":\"$BINID\",\"expected\":{\"rfidTag\":null,\"tareWeightKg\":0},\"emptyConfirmed\":false}"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'content-type: application/json' -d "$C" $L/api/register/confirm)" = 409 ] || fail "not confirmed empty must be refused"
C="{\"carrierId\":\"$BINID\",\"expected\":{\"rfidTag\":null,\"tareWeightKg\":0},\"emptyConfirmed\":true}"
R=$(curl -s -X POST -H "$H" -H 'content-type: application/json' -d "$C" $L/api/register/confirm)
[ "$(echo "$R" | jq -r .carrier.tareWeightKg)" = 154.4 ] || fail "register: $R"
waitfor .registration.phase.phase saved
frames '   154.4G' 3
[ "$(state | jq -r .registration.phase.phase)" = saved ] || fail "still on the scale: no next measurement"
[ "$(state | jq '.recent | length')" = 0 ] || fail "registration must not create a weighing"
curl -s -X POST -H "$H" $L/api/register/stop > /dev/null
frames '     0.0G' 3
curl -s -X POST -H "$H" $L/api/session/logout > /dev/null

echo "== 2. a phone chooses the bin (the server's real phone-sync route)"
AT=$(date -u -d '-20 minutes' +%Y-%m-%dT%H:%M:%S.000Z)
EV="{\"events\":[{\"clientEventId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"deviceSeq\":1,\"eventType\":\"work_start\",\"occurredAtUtc\":\"$AT\",\"activityId\":\"$(j .activityId)\",\"carrierId\":\"$BINID\",\"answers\":[{\"questionId\":\"$(j .questionId)\",\"carrierId\":\"$BINID\"}]}]}"
[ "$(curl -s -X POST -H 'content-type: application/json' -H "X-Device-Id: $(j .deviceIdentifier)" -d "$EV" http://127.0.0.1:4050/api/mobile/sync/events | jq -r '.results[0].status')" = accepted ] || fail "phone sync"

echo "== 3. the bin is weighed and credited from the phone's choice (trial)"
sleep 2
tag "$TAG"
frames '   172.5G' 13
waitfor .phase.phase awaitingRemoval
[ "$(state | jq -c '[.recent[0].grossG, .recent[0].tareG, .recent[0].netG]')" = '[172500,154400,18100]' ] || fail "weights"
waitfor '.recent[0].assignmentStatus' credited
[ "$(state | jq -r .recent[0].creditsLive)" = false ] || fail "trial credit"
state | jq -c '.recent[0] | {carrierName, netG, assignmentStatus, employeeName, creditsLive}'

echo "== 4. the same bin straight back is not weighed again"
frames '     0.0G' 3
tag "$TAG"
frames '   172.5G' 13
[ "$(state | jq -r .phase.reason.code)" = recentlyWeighed ] || fail "duplicate guard"
[ "$(state | jq '.recent | length')" = 1 ] || fail "one weighing"
kill $SVC
echo "PASS"
