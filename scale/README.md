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
| `.deb` (service + display + systemd + udev + autostart) | Builds and installs on Ubuntu 24.04. Not yet installed on the NUC |
| Server `/api/scale/*` endpoints, migration, matching, expiry | **Not built.** Contract proposed in ARCHITECTURE §5 |
| R300 and PROTAGD protocols | **Unverified.** Waiting for the adapter. Use `capture` |

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
# Service: 78 tests (parsers, state machine, matching rule, store, end to end in simulation)
docker run --rm -v "$PWD":/work -w /work/scale/service labourlink-scale-build cargo test
# Display: 21 tests
cd scale/app && npx vitest run
```

## Build the .deb

```sh
docker run --rm -v "$PWD":/work labourlink-scale-build sh /work/scale/docker/build-deb.sh
# → scale/dist/labourlink-scale_0.2.0_amd64.deb (~4 MB)
```

To install on the NUC:

```sh
sudo apt install ./labourlink-scale_0.2.0_amd64.deb
```

The package starts `labourlink-scaled` in **simulation** mode and adds the display to XFCE autostart. Then run `sh /usr/share/labourlink-scale/setup-kiosk.sh` as the station user and enable automatic login.

## When the hardware arrives

```sh
labourlink-scaled list-ports
sudo systemctl stop labourlink-scaled
sudo labourlink-scaled capture --port /dev/ttyUSB0 --seconds 60 --out rfid.txt   # present tags
sudo labourlink-scaled capture --port /dev/ttyUSB1 --seconds 120 --out r300.txt  # empty, then bin on, then off
```

`capture` only reads the port. It never writes to the port, so it cannot change indicator calibration or settings. Send both files back so the parsers and the udev rule can be confirmed before anything goes live.

## Going live (not yet possible)

Live mode needs the server endpoints from ARCHITECTURE §5 and a station token. Once those exist, the steps are:
1. Copy `/usr/share/labourlink-scale/config.live.example.json` to `/etc/labourlink-scale/config.json` and set `apiBaseUrl`.
2. Put the token in `/etc/labourlink-scale/station-token` with mode 0600.
3. Restart the service with `systemctl restart labourlink-scaled`.

Live mode uses its own database. Simulated weighings can never be uploaded.
