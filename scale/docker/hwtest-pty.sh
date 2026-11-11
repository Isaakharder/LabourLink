#!/bin/sh
# Black-box check of hardware-test mode with virtual serial ports.
#
# Runs the real labourlink-scaled binary in hardware-test mode against two
# socat pseudo-terminal pairs named like the NUC's devices, feeds them
# R300 Format A frames and PROTAGD lines, and checks the local API. Run it in
# a container with no network, so any attempt to reach a server would fail:
#
#   docker run --rm --network none -v "$PWD":/work -v llscale-cargo:/usr/local/cargo/registry \
#     -v llscale-test-target:/cache/target -e CARGO_TARGET_DIR=/cache/target \
#     labourlink-scale-hwtest sh /work/scale/docker/hwtest-pty.sh
#
# (labourlink-scale-hwtest = labourlink-scale-build plus socat, curl and jq.)
set -eu
BIN=${CARGO_TARGET_DIR:-/work/scale/service/target}/debug/labourlink-scaled
cd /work/scale/service && cargo build -q --offline
T=/tmp/hw && rm -rf $T && mkdir -p $T/dev/serial/by-id $T/dev/labourlink $T/data
SCALE=$T/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_BG0427FU-if00-port0
RFID=$T/dev/labourlink/rfid
socat pty,raw,echo=0,link=$T/scale-feed pty,raw,echo=0,link=$SCALE &
socat pty,raw,echo=0,link=$T/rfid-feed pty,raw,echo=0,link=$RFID &
sleep 1
cat > $T/config.json <<EOF
{
  "mode": "hardware-test",
  "stationName": "PTY hardware test",
  "dataDir": "$T/data",
  "scale": { "port": "$SCALE", "baud": 9600, "protocol": "rinstrum-auto-a" },
  "rfid": { "port": "$RFID", "baud": 9600 },
  "testCarriers": [ { "name": "Bin 23", "rfidTag": "0000000182225750", "tareKg": 27.5 } ]
}
EOF
$BIN --config $T/config.json > $T/service.log 2>&1 &
SVC=$!
sleep 2
state() { curl -s http://127.0.0.1:47800/api/state; }
fail() { echo "FAIL: $1"; echo "--- state"; state | jq -c '{phase, connections, scaleOnline, recent}'; echo "--- log"; cat $T/service.log; exit 1; }
# frames <body> <seconds>: one Format A frame every 100 ms.
frames() { n=$(( $2 * 10 )); while [ $n -gt 0 ]; do printf '\002%s\003' "$1" > $T/scale-feed; sleep 0.1; n=$((n - 1)); done; }
tag() { printf 'R 0000 %s\r\n' "$1" > $T/rfid-feed; }

echo "== 1. data in another format is reported, never weighed"
n=60; while [ $n -gt 0 ]; do printf '  93.0kg G\r\n' > $T/scale-feed; sleep 0.1; n=$((n - 1)); done
[ "$(state | jq -r .connections.scale.state)" = unrecognized ] || fail "unparsed data should show as unrecognized"
state | jq -r .connections.scale.detail
grep -q "not recognised" $T/service.log || fail "journal should log unrecognised frames"

echo "== 2. both ports read at once: tag + R300 frames record one weighing"
frames '     0.0G' 3
[ "$(state | jq -r .connections.scale.state)" = connected ] || fail "good frames should clear unrecognized"
tag 0000000182225750
frames '   110.2M' 1
tag 0000000182225750
frames '   110.2G' 13
S=$(state)
echo "$S" | jq -c '{mode, simulated, phase: .phase.phase, scale: .connections.scale.state, rfid: .connections.rfid.state, server: .connections.server.state}'
[ "$(echo "$S" | jq -r .mode)" = hardware-test ] || fail mode
[ "$(echo "$S" | jq -r .connections.rfid.state)" = connected ] || fail "rfid port"
[ "$(echo "$S" | jq -r .connections.server.state)" = simulated ] || fail "server must be the test server"
[ "$(echo "$S" | jq -r .phase.phase)" = awaitingRemoval ] || fail "should have recorded"
[ "$(echo "$S" | jq -c '[.recent[0].grossG, .recent[0].tareG, .recent[0].netG, .recent[0].simulated]')" = '[110200,27500,82700,true]' ] || fail "weights"
sleep 3
S=$(state)
[ "$(echo "$S" | jq -r .recent[0].assignmentStatus)" = pending ] || fail "test server should hold it pending"
[ "$(echo "$S" | jq -r .recent[0].employeeName)" = null ] || fail "nobody credited"

echo "== 3. zero reset, then the same bin straight back is not recorded twice"
frames '     0.0G' 3
tag 0000000182225750
frames '   110.2G' 13
[ "$(state | jq -r .phase.reason.code)" = recentlyWeighed ] || fail "duplicate guard"
[ "$(state | jq '.recent | length')" = 1 ] || fail "still one weighing"

echo "== 4. a tag not in testCarriers is never weighed"
frames '     0.0G' 3
tag 0000000155555555
frames '    93.0G' 13
[ "$(state | jq -r .phase.reason.code)" = unknownTag ] || fail "unknown tag"
[ "$(state | jq '.recent | length')" = 1 ] || fail "still one weighing"

echo "== 5. no simulator in hardware-test mode"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"grossKg":50}' http://127.0.0.1:47800/api/sim/place)" = 404 ] || fail "sim routes"

echo "== 6. the hardware-test database"
ls $T/data
[ -f $T/data/scale-hwtest.sqlite3 ] && [ ! -e $T/data/scale.sqlite3 ] || fail "database file"
kill $SVC
echo "PASS"
