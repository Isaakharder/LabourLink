#!/bin/sh
# The fixed 10-second measurement against virtual serial ports: Register Bins
# and harvest weighing, for the bin behaviours seen on the NUC.
#
# Runs the real labourlink-scaled binary in hardware-test mode (in-process
# test server, no network), feeds R300 Format A frames and PROTAGD tag lines,
# and prints one line per scenario. With EXPECT=1 it also checks each outcome
# (Register Bins: readings within 0.9 kg; harvest weighing: the latest
# reading at 10 s, any fluctuation) and exits non-zero on any mismatch.
#
#   docker run --rm --network none -v "$PWD":/work -v llscale-cargo:/usr/local/cargo/registry \
#     -v llscale-test-target:/cache/target -e CARGO_TARGET_DIR=/cache/target -e EXPECT=1 \
#     labourlink-scale-hwtest sh /work/scale/docker/hwtest-cycle.sh
set -eu
BIN=${CARGO_TARGET_DIR:-/work/scale/service/target}/debug/labourlink-scaled
cd /work/scale/service && cargo build -q --offline
T=/tmp/cy && rm -rf $T && mkdir -p $T/dev $T/data
SCALE=$T/dev/scale
RFID=$T/dev/rfid
socat pty,raw,echo=0,link=$T/scale-feed pty,raw,echo=0,link=$SCALE &
socat pty,raw,echo=0,link=$T/rfid-feed pty,raw,echo=0,link=$RFID &
sleep 1
# Sixteen bins, one per weighing scenario (so the 5-minute duplicate guard
# never mixes scenarios up), all with a 27.5 kg tare.
BINS=""
i=1; while [ $i -le 16 ]; do
  BINS="$BINS{\"name\":\"Bin $i\",\"rfidTag\":\"00000001822257$(printf %02d $i)\",\"tareKg\":27.5},"
  i=$((i + 1))
done
cat > $T/config.json <<EOF
{
  "mode": "hardware-test",
  "stationName": "PTY cycle test",
  "dataDir": "$T/data",
  "scale": { "port": "$SCALE", "baud": 9600, "protocol": "rinstrum-auto-a" },
  "rfid": { "port": "$RFID", "baud": 9600 },
  "testCarriers": [ ${BINS%,} ]
}
EOF
$BIN --config $T/config.json > $T/service.log 2>&1 &
SVC=$!
sleep 2
state() { curl -s http://127.0.0.1:47800/api/state; }
api() { curl -s -X POST -H 'content-type: application/json' -H "X-Session-Token: ${TOK:-}" -d "$2" "http://127.0.0.1:47800$1"; }
tag() { printf 'R 0000 %s\r\n' "$1" > $T/rfid-feed; }
frame() { printf '\002%s\003' "$1" > $T/scale-feed; }
zero() { n=30; while [ $n -gt 0 ]; do frame '     0.0G'; sleep 0.1; n=$((n - 1)); done; }

# bin <base, tenths of kg> <spread, tenths> <motion: none|some|all> <seconds> [stop_after_s]
# A triangle wobble 0 → spread → 0 tenths around base, one frame per 100 ms.
# some = every third frame is a motion (M) frame; all = every frame is M
# except the very first (the indicator showed gross when the bin arrived).
bin() {
  base=$1 spread=$2 motion=$3 secs=$4
  n=0 total=$((secs * 10))
  while [ $n -lt $total ]; do
    if [ "$spread" -gt 0 ]; then
      p=$(( n % (2 * spread) )); off=$(( p <= spread ? p : 2 * spread - p ))
    else off=0; fi
    v=$((base + off))
    st=G
    case $motion in some) [ $((n % 3)) = 1 ] && st=M ;; all) [ $n -gt 0 ] && st=M ;; esac
    frame "$(printf ' %5d.%d%s' $((v / 10)) $((v % 10)) $st)"
    sleep 0.1; n=$((n + 1))
  done
}

FAILS=0
# report <scenario> <expected> <actual>
report() {
  mark=""
  if [ "${EXPECT:-0}" = 1 ]; then
    if [ "$2" = "$3" ]; then mark="ok  "; else mark="FAIL"; FAILS=$((FAILS + 1)); fi
  fi
  printf '%s %-58s %s\n' "$mark" "$1" "$3"
}
reg_outcome() {
  state | jq -r '.registration.phase | if .phase == "proposed" then "proposed \(.proposal.grossG / 1000) kg (\(.proposal.samplesG | length) readings, spread \(((.proposal.samplesG | max) - (.proposal.samplesG | min)) / 1000) kg)"
    elif .phase == "problem" then "refused: \(.reason.code)\(if .reason.why then "/" + .reason.why.code else "" end)" else .phase end'
}
reg_short() { state | jq -r '.registration.phase | if .phase == "proposed" then "proposed" elif .phase == "problem" then "refused:\(.reason.code)\(if .reason.why then "/" + .reason.why.code else "" end)" else .phase end'; }

TOK=$(api /api/session/login '{"email":"picker@sim.local","pin":"1234"}' | jq -r .token)
[ -n "$TOK" ] && [ "$TOK" != null ] || { echo "cannot sign in to the test server"; cat $T/service.log; exit 1; }

echo "== Register Bins (empty bin 143.6 kg, tag read once as it rolls on)"
api /api/register/start '{}' > /dev/null
r=10
regcase() { # regcase <label> <expect> <spread> <motion> [notag]
  r=$((r + 1)); zero
  [ "${5:-}" = notag ] || tag "00000001374806$r"
  bin 1436 "$3" "$4" 14
  out=$(reg_outcome); short=$(reg_short)
  report "R $1" "$2" "$short"; echo "       $out"
}
regcase "stable bin"                         proposed 0 none
regcase "fluctuating 0.1 kg"                 proposed 1 none
regcase "fluctuating 0.5 kg"                 proposed 5 none
regcase "fluctuating 0.9 kg with motion"     proposed 9 some
regcase "indicator reports motion throughout (0.3 kg)" proposed 3 all
regcase "fluctuating 1.0 kg (over the limit)" "refused:weightNotCaptured/unsteady" 10 none
regcase "missing RFID"                       refused:noTag 0 none notag

r=$((r + 1)); zero; tag "00000001374806$r"; bin 1436 0 none 6; zero
report "R bin removed before 10 s" ready "$(reg_short)"

# badcase <label> <frame body>: 9 s of a good bin, 1 s of bad frames across
# the 10 s mark, then 1 s of good frames. The bin must never be proposed from
# that cycle (the bad frames are inside the 2 s measurement window).
badcase() {
  r=$((r + 1)); zero; tag "00000001374806$r"; bin 1436 0 none 9
  n=10; while [ $n -gt 0 ]; do frame "$2"; sleep 0.1; n=$((n - 1)); done
  bin 1436 0 none 1
  short=$(reg_short)
  [ "$short" = proposed ] && got=proposed || got="not proposed"
  report "R $1" "not proposed" "$got"; echo "       $short"
  bin 1436 0 none 1; zero
}
badcase "indicator error frames (E) at 10 s"        '        E'
badcase "overload frames (O) at 10 s"               '        O'
badcase "net-mode frames (N) at 10 s"               '   143.6N'
badcase "negative weight frames at 10 s"            '-  143.6G'
# Unreadable data for the last 3 s: too few readings at 10 s, refused.
r=$((r + 1)); zero; tag "00000001374806$r"; bin 1436 0 none 8
n=30; while [ $n -gt 0 ]; do frame 'garbage!!'; sleep 0.1; n=$((n - 1)); done
short=$(reg_short); [ "$short" = proposed ] && got=proposed || got="not proposed"
report "R unreadable scale data at 10 s" "not proposed" "$got"; echo "       $short"
r=$((r + 1)); zero; tag "00000001374806$r"; bin 1436 0 none 8; sleep 3
short=$(reg_short); [ "$short" = proposed ] && got=proposed || got="not proposed"
report "R readings stop (scale data missing)" "not proposed" "$got"; echo "       $short"

echo "== Register Bins: a valid measurement saved (test server)"
r=$((r + 1)); zero; tag "00000001374806$r"; bin 1436 9 some 14
api /api/register/confirm '{"carrierId":"test-carrier-01","expected":{"rfidTag":"0000000182225701","tareWeightKg":27.5},"emptyConfirmed":true,"confirmOverwrite":true}' > $T/confirm.json
report "R 0.9 kg bin confirmed and saved" saved "$(reg_short)"
jq -c '{saved: .carrier.name, tag: .carrier.rfidTag, tareKg: .carrier.tareWeightKg, error: .error}' $T/confirm.json | sed 's/^/       /'
[ "$(state | jq '.recent | length')" = 0 ] || { echo "FAIL registration created a weighing"; FAILS=$((FAILS + 1)); }
zero
api /api/register/stop '{}' > /dev/null

echo "== Harvest weighing (bin tare 27.5 kg, full 110.2 kg)"
k=2
wcase() { # wcase <label> <expect> <spread> <motion> [notag]
  t="00000001822257$(printf %02d $k)"; k=$((k + 1))
  zero
  [ "${5:-}" = notag ] || tag "$t"
  bin 1102 "$3" "$4" 14
  short=$(state | jq -r '.phase | if .phase == "awaitingRemoval" then "recorded" elif .phase == "blocked" then "refused:\(.reason.code)\(if .reason.why then "/" + .reason.why.code else "" end)" else .phase end')
  report "W $1" "$2" "$short"
  [ "$short" = recorded ] && state | jq -r '.recent[0] | "       recorded gross \(.grossG / 1000) kg, net \(.netG / 1000) kg"' || true
}
wcase "stable bin"                     recorded 0 none
wcase "fluctuating 0.5 kg"             recorded 5 none
wcase "fluctuating 0.5 kg with motion" recorded 5 some
wcase "fluctuating 1.1 kg (bin 73)"    recorded 11 none
wcase "fluctuating 1.1 kg with motion" recorded 11 some
wcase "fluctuating 2.0 kg"             recorded 20 none
wcase "fluctuating 2.0 kg with motion" recorded 20 some
wcase "fluctuating 3.0 kg"             recorded 30 none
wcase "fluctuating 3.0 kg, motion throughout" recorded 30 all
wcase "missing RFID"                   refused:noTag 0 none notag
zero; tag "00000001822257$(printf %02d $k)"; bin 1102 0 none 6; zero
report "W bin removed before 10 s" idle "$(state | jq -r .phase.phase)"
zero; tag 0000000182225702; bin 1102 0 none 14
report "W same bin again within 5 minutes" refused:recentlyWeighed "$(state | jq -r '.phase | if .phase == "blocked" then "refused:\(.reason.code)" else .phase end')"
zero
COUNT=$(state | jq '.recent | length')
report "W weighings recorded in total" 9 "$COUNT"

kill $SVC
if [ "${EXPECT:-0}" = 1 ]; then
  [ $FAILS = 0 ] && echo "PASS" || { echo "$FAILS scenario(s) did not match"; exit 1; }
fi
