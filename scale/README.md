# LabourLink Scale

Weighing station for the packhouse. It runs on an Intel NUC5CPYH with Linux Mint 22.3, a PROTAGD RFID reader and a Rinstrum R300 indicator. When a bin is placed on the scale, its RFID tag identifies the carrier. The station waits for a stable gross weight, subtracts the carrier's tare and records the net weight. The LabourLink server then credits the picker who verifiably scanned that bin in the same use cycle.

Bins are registered at the station itself: **Register Bins** measures an empty bin and writes its tag and tare to its LabourLink carrier record.

For the design, the 24-hour pending rule and the server contract, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The server side is in `server/src/routes/scale.ts` (station API and Register Bins), `server/src/lib/scaleMatching*.ts` (who gets credit) and `server/src/routes/scaleWeighings.ts` (the Scale Weighings page).

```
scale/
  service/    labourlink-scaled: Rust background service (serial, state machine, SQLite, local API)
  app/        labourlink-scale: Tauri 2 + React full-screen display
  packaging/  systemd unit, udev rules, XFCE autostart, kiosk script, configs, deb scripts
  docker/     Ubuntu 24.04 build image and .deb build script
```

## Status

| Area | State |
|---|---|
| Weighing state machine (10 s settle, stable weight, duplicate and next-bin rules) | Done, unit-tested |
| SQLite outbox, offline queue, restart recovery | Done, unit-tested |
| Display: weighing screen, status bar, recent weighings | Done, tested in a browser and with component tests |
| Register Bins (any signed-in user; empty bin measured on the scale; tag and tare saved to the existing carrier, audited) | Done. Tested against the simulator and end to end against a local LabourLink server |
| Simulation mode (fake scale, reader, server, phones) | Done |
| Hardware-test mode (real scale and reader, test bins, test server, nothing sent) | Done. Run on the NUC with 0.2.1: real R300 and PROTAGD data, Bin 77 weighed |
| `.deb` (service + display + systemd + udev + autostart) | Builds and installs on Ubuntu 24.04. Not yet installed on the NUC |
| Server `/api/scale/*` endpoints, migrations 070–072, matching, expiry, Scale Weighings page | Built on branches (PRs). **Not merged or deployed** |
| Live mode against a LabourLink server | Tested end to end against a local test server. Credits start off (trial) |
| R300 and PROTAGD protocols | Confirmed on the NUC with 0.2.1 hardware-test mode (gross readings, tags, duplicate guard) |

## Run it locally (simulation)

The service has to run on Linux. From any machine with Docker:

```sh
docker build -t labourlink-scale-build -f scale/docker/Dockerfile.build scale/docker
# Service in simulation mode. socat relays it, because the service only listens on 127.0.0.1.
docker run -d --name llscale-sim -p 127.0.0.1:47800:47801 -v "$PWD":/work -w /work/scale/service \
  labourlink-scale-build sh -c "apt-get update -qq && apt-get install -y -qq socat; \
  (socat TCP-LISTEN:47801,fork,reuseaddr TCP:127.0.0.1:47800 &); cargo run"
# Display in a browser
cd scale/app && npm install && npm run dev      # http://localhost:5174
```

On the NUC itself (or any Linux machine), run `cargo run` in `service/` and `npm run tauri dev` in `app/`.

In simulation, use the **Simulator** drawer to:
- place or remove bins, including an unregistered tag or no tag
- make the weight wobble, take the scale or reader offline, put the indicator in NET mode, or overload it
- cut the "server" connection
- sync a picker's phone scan for a specific earlier weighing (a delayed, offline scan), for a bin's next use, or (advanced) N minutes ago, optionally with a flagged clock
- simulate 24 hours passing, which expires unassigned weighings once without shifting any clocks

The **Simulated server** list shows each weighing's status, and each scan is labelled with what happened to it: credited this use, conflict (flagged, credit unchanged), waiting for the bin's next weighing, too late (that use expired), or ignored (clock flagged).

Register Bins sign-in in simulation: `picker@sim.local` / `1234`. Any user can register bins. The drawer's **Station credits on** switch shows what a trial station looks like.

## Tests

```sh
# Service: 99 tests (parsers, state machine, Register Bins, matching rule incl. the server's shared cases, store, end to end in simulation and hardware test)
docker run --rm -v "$PWD":/work -w /work/scale/service labourlink-scale-build cargo test
# Display: 34 tests
cd scale/app && npx vitest run
# Hardware-test mode end to end: the real binary, virtual serial ports named like the NUC's, no network.
# Needs an image with socat, curl and jq (see the script's header).
docker run --rm --network none -v "$PWD":/work -v llscale-cargo:/usr/local/cargo/registry   labourlink-scale-hwtest sh /work/scale/docker/hwtest-pty.sh
# Live mode end to end against a LOCAL LabourLink test server (see the script's header): Register Bins,
# a phone bin choice through the real phone-sync route, the weighing credited (as a trial), the duplicate guard.
docker run --rm -v "$PWD":/work -v /path/to/e2e.json:/e2e/e2e.json -e E2E_SERVER=host.docker.internal:4050 \
  -v llscale-cargo:/usr/local/cargo/registry labourlink-scale-hwtest sh /work/scale/docker/live-e2e.sh
```

## Build the .deb

```sh
docker run --rm -v "$PWD":/work labourlink-scale-build sh /work/scale/docker/build-deb.sh
# → scale/dist/labourlink-scale_0.3.0_amd64.deb (~4 MB)
```

To install on the NUC:

```sh
sudo apt install ./labourlink-scale_0.3.0_amd64.deb
```

The package starts `labourlink-scaled` in **simulation** mode and adds the display to XFCE autostart. Then run `sh /usr/share/labourlink-scale/setup-kiosk.sh` as the station user and enable automatic login.

## Hardware test mode

Hardware-test mode reads the **real** scale indicator and RFID reader at the same time and runs the normal weighing rules on them. Nothing goes to LabourLink.

The rules that run are the 10 s settle, the stable weight, tare and net, duplicate prevention, return to zero, and the pending assignment.

- **Bins** come from `testCarriers` in the config file: a real tag and that bin's real tare, copied from the Carriers page. Tags that aren't listed show "Unregistered RFID tag" with the tag number, which is the easiest way to read a bin's tag.
- **The "server"** is the same in-process test server as simulation. The service builds no HTTP client, so nothing can be uploaded and no credit can be created. Weighings show "Awaiting assignment" because no phone scans exist.
- **Separate data.**
  - Weighings are test data in their own database, `scale-hwtest.sqlite3`.
  - That database refuses to open in live or simulation mode.
  - It also refuses a non-test row.
- **No simulator.** The simulator drawer and `/api/sim/*` are off.
- **On screen:**
  - A striped "HARDWARE TEST MODE" banner shows the whole time.
  - The **Scale** and **RFID** pills show the real ports; **LabourLink** shows *Simulated*.
  - If the indicator sends data the configured protocol can't parse, the screen says **Scale data not recognised** and the journal logs the frames. Such data is never weighed.
- **Stable device paths.** The packaged `config.hardware-test.json` uses:
  - `/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_BG0427FU-if00-port0` for the scale;
  - `/dev/labourlink/rfid` for the reader. The udev rule creates it from the FT230X's USB ids.
  - Never `ttyUSB0`/`ttyUSB1`. Both ports are opened read-only at 9600 8N1 with no flow control.

### On the NUC

```sh
# 1. Install 0.2.1. The existing /etc/labourlink-scale/config.json is kept, so the service restarts in simulation.
sudo apt install ./labourlink-scale_0.3.0_amd64.deb

# 2. Both devices must have stable names.
ls -l /dev/serial/by-id/ /dev/labourlink/

# 3. Confirm the indicator and reader formats. Read-only; the service must be stopped while capturing.
sudo systemctl stop labourlink-scaled
sudo labourlink-scaled capture --port /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_BG0427FU-if00-port0 --seconds 90 --out ~/r300.txt
#    0-15 s scale empty | 15 s put a bin on | 30-40 s rock the bin | 40-70 s leave it still | 70 s take it off
sudo labourlink-scaled capture --port /dev/labourlink/rfid --seconds 30 --out ~/rfid.txt
#    hold one bin's tag at the reader for 10 s, take it away, then another tag
grep '^#' ~/r300.txt
grep '^#' ~/rfid.txt

# 4. Switch to hardware test and add the test bins.
sudo cp /etc/labourlink-scale/config.json /etc/labourlink-scale/config.before-hardware-test.json
sudo install -m 0644 /usr/share/labourlink-scale/config.hardware-test.json /etc/labourlink-scale/config.json
sudo nano /etc/labourlink-scale/config.json
sudo systemctl enable labourlink-scaled
sudo systemctl restart labourlink-scaled
journalctl -u labourlink-scaled -n 30 --no-pager
# 5. Restart the display so it runs the 0.2.1 build.
sudo reboot
```

In step 4, replace `"testCarriers": []` with the bins to test. Use the tag and the tare from that bin's Carriers page in LabourLink:

```json
"testCarriers": [
  { "name": "Bin 23", "rfidTag": "0000000182225750", "tareKg": 27.5 }
]
```

The service refuses to start, and the journal says why, if:
- a tag is malformed or repeated;
- a name is blank;
- a tare isn't more than 0.

**Reading the capture.**
- **Shapes.** `grep '^#' ~/r300.txt` lists every frame shape with its count, weights and an example, then the frames as a time-ordered list of runs.
  - The parser expects Rinstrum Format A: `<STX>`, a sign, 7 weight characters and one status letter, then `<ETX>`.
  - It reads the letters as G gross, N net, M motion, O overload, U underload and E error. **That reading comes from the manual and is not yet confirmed.**
- **Match the runs to what you did.** Check them against step 3's timings:
  - the empty and still periods should be one letter (expected `G`);
  - rocking should switch to another (expected `M`).
- **If they don't match.** Hardware-test results aren't trustworthy yet, and you should send the file back, if:
  - rocking doesn't change the letter;
  - a shape other than "STX body 9 chars" appears;
  - the rate is under 2.5 frames/s.
  - Even then, the station's own check (2 s window, at most 0.05 kg spread) still has to pass before anything is recorded.
- **Repeat reads.** The RFID summary shows whether the reader repeats a tag while it's in range.

**Back to simulation:**

```sh
sudo install -m 0644 /usr/share/labourlink-scale/config.simulation.json /etc/labourlink-scale/config.json
sudo systemctl restart labourlink-scaled
```

Hardware-test weighings stay in `/var/lib/labourlink-scale/scale-hwtest.sqlite3` until that file is deleted. Delete it only with the service stopped.

## Register Bins

**Weighing pauses while Register Bins is open.** Readings and tags go to the registration machine, so registering can never create a weighing or credit anyone. When it closes, weighing starts over as if the station had just started: a bin left on the scale must be removed before anything is weighed.

1. **Sign in.** Press **Register Bins** and sign in with any LabourLink email and PIN.
2. **Clear the scale.** It must read zero for 2 seconds, on entry and after every bin.
3. **Roll on one completely empty bin.** The station:
   - reads its tag;
   - waits the 10-second settle and a stable gross reading;
   - proposes that weight as the tare.

   It refuses when:
   - no tag or more than one tag is read;
   - the weight is near zero or unstable;
   - the indicator is not in gross mode.
4. **Enter the bin's LabourLink number** (on-screen keypad) and pick the bin.
5. **Check the bin, RFID tag and tare.**
   - Replacing an existing tag or tare must be ticked explicitly.
   - So must moving a tag that is registered to another bin. Use that only to fix a bin registered by mistake; the wrong bin gets its previous tare back.
6. **Tick "This bin is completely empty" and register.**
   - Just before saving, the station checks the bin, weight and tag are unchanged.
   - The server checks everything again and records who registered it, at which station, and what was measured.
7. **Remove the bin.** The scale must return to zero before the next one.

**Corrections.**
- **Wrong tare:** register the bin again.
- **Tag on the wrong bin:** register the right bin and move the tag.
- **Tag no longer wanted:** Corrections → Remove a tag.

Every change appears in the bin's history on Basic Data > Carriers.

**When Register Bins closes by itself.** The person is signed out after 15 idle minutes, which also closes Register Bins.

## Going live

**Nothing goes live without the owner's approval.** That covers merging the server PRs, running migrations 070–072, creating the station token and turning credits on.

1. **Server.** Apply migrations 070, 071 and 072 in that order, each before its PR is merged and deployed.
2. **Station token.** On a development machine, run `npm run scale:station-token -- "Packhouse scale"`.
   - It prints a token and an `insert` statement.
   - Run the statement in the Supabase SQL Editor.
   - The station starts with credits **off** (trial).
3. **On the NUC:**

   ```sh
   sudo apt install ./labourlink-scale_0.3.0_amd64.deb
   sudo install -m 0644 /usr/share/labourlink-scale/config.live.example.json /etc/labourlink-scale/config.json
   sudo nano /etc/labourlink-scale/config.json          # apiBaseUrl: the LabourLink API's https:// address
   sudo sh -c 'umask 077; printf "%s" "PASTE-TOKEN-HERE" > /etc/labourlink-scale/station-token'
   sudo systemctl restart labourlink-scaled
   journalctl -u labourlink-scaled -n 30 --no-pager      # LIVE mode, carriers fetched
   sudo reboot                                          # the display picks up 0.3.0
   ```

4. **Register every bin** with Register Bins (empty, on the scale).
5. **Trial run.** While credits are off:
   - a striped **TRIAL** banner shows on the station;
   - weighings are uploaded and matched exactly as in production, but show "Trial: <name>" and never count as credits.

   Check them on the LabourLink **Scale Weighings** page.
6. **Turn credits on**, only with the owner's approval:

   ```sql
   update scale_stations set credits_enabled = true where name = 'Packhouse scale';
   ```

**Separate databases.** Live mode uses its own database (`scale.sqlite3`). Simulation and hardware-test weighings are in other files and can never be uploaded.

**Going back to hardware test:** install `config.hardware-test.json` again and restart the service. Weighings already queued in live mode stay in `scale.sqlite3` and are sent the next time live mode runs.
