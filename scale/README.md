# LabourLink Scale

Weighing station for the packhouse. It runs on an Intel NUC5CPYH with Linux Mint 22.3, a PROTAGD RFID reader and a Rinstrum R300 indicator. When a bin is placed on the scale, its RFID tag identifies the carrier. The station waits for a stable gross weight, subtracts the carrier's tare and records the net weight. The LabourLink server then credits the picker who verifiably scanned that bin in the same use cycle.

For the design, the 24-hour pending rule and the proposed server contract, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
| RFID registration using the existing login and Carriers API | Done. Tested against the simulator only |
| Simulation mode (fake scale, reader, server, phones) | Done |
| Hardware-test mode (real scale and reader, test bins, test server, nothing sent) | Done, tested with recorded R300-style frames. Needs a run on the NUC |
| `.deb` (service + display + systemd + udev + autostart) | Builds and installs on Ubuntu 24.04. Not yet installed on the NUC |
| Server `/api/scale/*` endpoints, migration, matching, expiry | **Not built.** Contract proposed in ARCHITECTURE §5 |
| R300 and PROTAGD protocols | **Unverified on the NUC.** Use `capture` (it now summarises frame shapes and status letters) before trusting hardware-test results |

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

Registration logins: `admin@sim.local` / `1234` (Administrator) and `manager@sim.local` / `1234` (refused).

## Tests

```sh
# Service: 90 tests (parsers, state machine, matching rule, store, end to end in simulation and hardware test)
docker run --rm -v "$PWD":/work -w /work/scale/service labourlink-scale-build cargo test
# Display: 27 tests
cd scale/app && npx vitest run
# Hardware-test mode end to end: the real binary, virtual serial ports named like the NUC's, no network.
# Needs an image with socat, curl and jq (see the script's header).
docker run --rm --network none -v "$PWD":/work -v llscale-cargo:/usr/local/cargo/registry   labourlink-scale-hwtest sh /work/scale/docker/hwtest-pty.sh
```

## Build the .deb

```sh
docker run --rm -v "$PWD":/work labourlink-scale-build sh /work/scale/docker/build-deb.sh
# → scale/dist/labourlink-scale_0.2.1_amd64.deb (~4 MB)
```

To install on the NUC:

```sh
sudo apt install ./labourlink-scale_0.2.1_amd64.deb
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
sudo apt install ./labourlink-scale_0.2.1_amd64.deb

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

## Going live (not yet possible)

Live mode needs the server endpoints from ARCHITECTURE §5 and a station token. Once those exist, the steps are:
1. Copy `/usr/share/labourlink-scale/config.live.example.json` to `/etc/labourlink-scale/config.json` and set `apiBaseUrl`.
2. Put the token in `/etc/labourlink-scale/station-token` with mode 0600.
3. Restart the service with `systemctl restart labourlink-scaled`.

Live mode uses its own database. Simulated weighings can never be uploaded.
