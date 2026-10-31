# LabourLink Scale: architecture

Status: phase 1 (local service, display and simulation). Nothing on the LabourLink server has changed yet. The station endpoints in §5 are a **proposal**.

## 1. Components

```
 NUC5CPYH · Linux Mint 22.3 XFCE
 ┌───────────────────────────────────────────────────────────────────────┐
 │  labourlink-scale (Tauri 2 + React)      labourlink-scaled (Rust)     │
 │  full-screen display, no logic   ◄─WS──  systemd service, DynamicUser │
 │                                  ──HTTP► 127.0.0.1:47800 only         │
 │                                          ├ serial: /dev/labourlink/rfid  (PROTAGD, FT230X, 9600)
 │                                          ├ serial: /dev/labourlink/scale (Rinstrum R300, RS-232, read-only)
 │                                          ├ weighing state machine (machine.rs)
 │                                          ├ SQLite: /var/lib/labourlink-scale (store.rs)
 │                                          └ uploader thread ──HTTPS──► LabourLink API
 └───────────────────────────────────────────────────────────────────────┘
```

- **The service owns everything that matters.** It owns both serial ports, the state machine, the SQLite outbox and server sync. It keeps weighing if the display is closed or crashes.
- **The display is a thin client.** It renders the snapshot the service streams and forwards button presses. It holds no business logic and exposes no Tauri commands.
- **Resource use.** The service uses about 5–6 MB RSS (measured in Ubuntu 24.04), and the systemd unit caps it at 128 MB. The display is one WebKitGTK window. Both fit the Celeron N3050 with 4 GB.

## 2. Service ↔ display boundary (local API)

The API binds to loopback only. Requests whose `Host` header is not loopback are rejected (a DNS-rebinding guard). CORS admits only the Tauri webview and the Vite dev server.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok, mode }` |
| GET | `/api/state` | Full snapshot (see `App::snapshot`, `app/src/types.ts`) |
| GET | `/api/ws` | WebSocket. Sends the snapshot, then every change (up to 10 Hz) |
| GET | `/api/rfid/last` | Latest tag read, for registration |
| POST | `/api/admin/login` | `{ email, pin }`, passed to the server's `POST /api/auth/login`. Only the Administrator role is accepted. Returns a local token (15 min idle) |
| POST | `/api/admin/logout` | Drops the local admin session |
| GET | `/api/admin/carriers?search=` | Passed to `GET /api/carriers` with the admin's session |
| POST | `/api/admin/rfid` | `{ carrierId, rfidTag \| null }`, passed to `PATCH /api/carriers/:id` |
| * | `/api/sim/*` | Simulator controls. Return **404 unless the service is in simulation mode** |

**RFID registration reuses the server as-is.** It uses the same login, the same Administrator check (`requireRole("Administrator")`), the same `parseRfidTag` validation and the same duplicate-tag 409 message as the Carriers page. Only `rfidTag` is sent in the PATCH, so no other carrier field can change. The admin's PIN is never stored. The server session cookie stays in service memory only.

## 3. Weighing state machine (`service/src/machine.rs`)

```
Starting ─► Idle ──load + exactly one known, active, tared tag──► Settling (10 s)
                                                                    │
           ◄── scale empty ≥ 2 s ── AwaitingRemoval ◄── Record ── Stabilizing (stable window)
any loaded phase ──problem──► Blocked(reason) ──resolved, or bin removed──► …
```

| Parameter (config key) | Default | Meaning |
|---|---|---|
| `settleSeconds` | 10 | Fixed settling period after the bin is identified on the scale |
| `stableWindowMs` | 2000 | Readings in this window must all agree |
| `stableToleranceKg` | 0.05 | Maximum spread (max − min) inside the window |
| `stableMinSamples` | 5 | Minimum readings in the window |
| `minLoadKg` / `zeroThresholdKg` | 2 / 1 | Thresholds for "loaded" and "empty" (hysteresis between them) |
| `removalMs` | 2000 | Scale must read empty this long before the next bin is accepted |
| `tagWindowMs` | 5000 | A tag counts for the load if it was read within this window |
| `minNetKg` | 0.5 | A lower net weight is treated as an empty bin and not recorded |
| `duplicateGuardSeconds` | 300 | The same bin can't be recorded twice within this period |
| `scaleTimeoutMs` | 2000 | No readings for this long means the scale is offline. Weighing pauses |

**Recording requires all of the following.** These rules are checked by unit tests, including a randomised test that never records a placement twice:

- **Tags:** exactly one distinct tag in the window. Two tags give *multiple tags* and stay blocked until removal.
- **Bin:** the tag maps to an active carrier with tare > 0.
- **Indicator status:** gross mode, with no overload, underload or error.
- **Timing:** the full 10 s settle, then a stable window with no motion flag and spread within tolerance.
- **Weight:** net ≥ minimum.

The recorded gross is the median of the stable window. Net is gross minus the carrier's tare **copied at that moment**.

**Duplicate prevention**
- After a record, nothing is weighed again until the scale reads empty for 2 s. Repeated tag reads are ignored.
- Lifting a bin and putting it back within 5 min is blocked as *recently weighed*. This guard is reloaded from SQLite after a restart.
- If the service starts with load already on the scale, it waits for removal first.
- Every weighing has a station UUID, and the server deduplicates on it.

**Next bin**
- Tags read before the previous bin was removed are forgotten, so a stale read cannot identify the next bin.
- A tag read once and kept: the identified tag is held for that load until the load is removed. This covers readers that report a tag only once.

**Save failure**
- If the SQLite insert fails, the record is undone and the screen shows "Weighing NOT saved".

**Calibration is never touched.** The indicator port is opened and read and never written, so the station cannot zero, tare or recalibrate it. If the indicator is in NET mode, weighing is blocked rather than adjusted.

## 4. Station SQLite schema (`service/src/store.rs`)

- **`carriers_cache`:** `id, name, rfid_tag (unique), tare_g, is_active, synced_at`. Refreshed every 5 minutes and right after a tag registration. Weighing keeps working offline from this cache.
- **`weighings`:** the outbox and history.
  - Identity: `id` (UUID), `carrier_id`, `carrier_name`, `rfid_tag`.
  - Weights: `gross_g`, `tare_g`, `net_g` (integer grams), `samples_json`.
  - Timing and mode: `recorded_at` (UTC), `simulated`.
  - Upload: `upload_state` (`queued`/`sent`/`rejected`), `upload_attempts`, `last_error`, `sent_at`.
  - Assignment: `assignment_status` (`unknown`/`credited`/`pending`/`needs_review`/`expired`/`voided`), `employee_name`, `pending_until`, `status_checked_at`.
  - Checks: `net_g = gross_g − tare_g` and `tare_g > 0`.
- **`meta`:** stores `mode`, `schema_version` and the time carriers were last synced.

**Durability:** WAL with `synchronous=FULL`. A weighing is committed before it's shown as recorded or uploaded.

**Upload order and failures**
- The outbox uploads oldest first and stops at the first connectivity failure, so order is preserved. Backoff runs from 5 s up to 2 min.
- A 4xx response other than auth marks the weighing `rejected`. It's kept and counted under "attention".
- A weighing the server says it has never seen is re-queued and sent again.

**Credit display follows the server.** The station never decides or keeps a credit of its own. Every poll it asks the server for the current status of every weighing sent in the last 48 hours, including credited and under-review ones. It stores exactly what the server answers, so a credit the server no longer holds (for example after a future, audited correction) disappears from the screen on the next poll. A status the station doesn't recognise is stored as `unknown`, which is never displayed as credited.

## 5. Server contract (PROPOSED: not implemented)

The station's live mode is written against this contract. **None of these endpoints or tables exist yet.** Building them is the next phase, with its own additive migration and review.

**Station authentication**
- A new `scale_stations` table holds `id, name, token_hash, is_active, last_seen_at`. The station sends `Authorization: Bearer <token>`.
- The token is created with a CLI, like `create-integration-token`. On the NUC it's stored root-only and given to the service with systemd `LoadCredential`.

| Method | Path | Body / response |
|---|---|---|
| GET | `/api/scale/carriers` | `{ carriers: [{ id, name, rfidTag, tareWeightKg, isActive }] }` |
| POST | `/api/scale/weighings` | `{ stationWeighingId, carrierId, rfidTag, grossG, tareG, netG, weighedAt, samplesG }` → `{ status, employeeName, pendingUntil }`. Idempotent on `(station, stationWeighingId)` |
| POST | `/api/scale/weighings/status` | `{ ids: [stationWeighingId…] }` → `{ statuses: { [id]: { status, employeeName, pendingUntil } } }`. Ids the server has never seen are omitted. Up to 100 ids per call |

**Proposed tables**
- **`weighings`**
  - Identity: `id`, `station_id`, `station_weighing_id` (unique per station), `carrier_id`, `rfid_tag`.
  - Weights: `gross_g`, `tare_g`, `net_g`, with a check that net = gross − tare.
  - Timing: `weighed_at` (station clock), `received_at`.
  - Assignment: `status`, `employee_id` (set only when credited), `match_reason`.
- **`weighing_claims`:** `weighing_id`, `mobile_time_event_id` (unique, so one phone event can support only one weighing).

**The assignment rule** (executable spec: `service/src/matching.rs`, plus multi-weighing cases in `sim.rs` and `app.rs`)

A bin-use cycle for carrier X weighed at T is **(previous weighing of X, T]**. Every weighing closes a cycle, whatever its outcome, so consecutive uses of the same bin (Bin 1 → Bin 1, or Bin 1 → Bin 2 → Bin 1) are independent: an earlier credit never blocks a later one, and a scan can only ever count for the use it happened in. A *claim* is an accepted `mobile_time_events` row, inside the cycle, in which the employee switched to X. Claims whose phone clock was flagged (backwards jump, or future time clamped) never count.

| Claims in the cycle | Result |
|---|---|
| Exactly one employee | **credited** to that employee. Their claims are consumed |
| None yet | **pending**, re-evaluated whenever a phone syncs bin changes |
| Still none 24 h after `weighed_at` | **expired**: permanently discarded. Never credited and never assignable; there is no manual assignment for it. Only its time is kept, as the boundary of the bin's next cycle |
| Two or more employees | **needs review**. Nobody is credited |
| A later claim from a *different* employee inside an already credited cycle | **Credit unchanged.** The claim is flagged as a conflict for supervisor review. Any correction must be an explicit, authorized and audited action (not built) |

**Final states.** Credited, needs review and expired never change because of a phone sync. Historical credits are therefore stable; only a future, audited administrator action could alter one.

**The 24-hour pending recovery rule.** A weighing without a verified assignment stays pending for 24 hours after it was weighed. Any phone sync in that time that delivers a claim inside that bin use's cycle resolves it. A sync that arrives after expiry changes nothing and the claim cannot spill into the bin's next use. After 24 hours the weighing expires uncredited and is discarded.

That window runs on the server, because only the server sees phone syncs. The station's outbox has no time limit: a weighing that couldn't be uploaded is kept and resent however long the network is down.

**Matching triggers**
- When a weighing arrives.
- After a phone sync that contains bin changes, run in its own transaction so matching can never break phone sync.
- An expiry job (Railway cron).

**Known limits, inherited from the phone app**
- A picker who refills the same bin without scanning another bin in between produces no new claim. The phone shows "Already using this bin". That weighing will be pending and then expire, never guessed.
- Phones can't scan bins offline today, though choosing a bin manually does queue offline.
- Both limits need a phone app v2: an explicit scan event on every scan, plus offline bin scans.

## 6. Keeping simulation away from production

1. **Mode is fixed at startup.** Simulation is the default, and a fresh `.deb` install starts in simulation. Live mode must be set explicitly and requires an `https://` API URL.
2. **No network path in simulation.** Simulation never constructs the HTTP client. Its backend is an in-process fake (`sim.rs`) with obviously fake bins ("Sim Bin n") and pickers ("Picker Alpha", …).
3. **Separate databases.** Simulation uses `scale-sim.sqlite3` and live uses `scale.sqlite3`. Each file is stamped with its mode and refuses to open in the other mode.
4. **Database-level guard.** A trigger rejects simulated rows in a live database (and real rows in a simulation database), even through raw SQL. The fake server also rejects non-simulated rows.
5. **The upload contract has no `simulated` flag.** The only route to the real API is the live outbox, which can only contain live rows.
6. **The simulator can't be reached in live mode.** `/api/sim/*` returns 404. The UI shows a striped "SIMULATION MODE" banner and a dashed outline the whole time.
7. **Hardware-test mode keeps rules 2–5.**
   - It reads the real serial ports.
   - Its backend is the in-process test server, holding only the bins listed in `testCarriers`. No HTTP client is built.
   - Its database is `scale-hwtest.sqlite3`, stamped `hardware-test`, and its rows are test data (`simulated = 1`).
   - `/api/sim/*` returns 404, because there is no simulator rig.
   - The UI shows a striped "HARDWARE TEST MODE" banner.

## 7. Needs the real hardware to verify

- **R300 output format** (protocol, rate, units, decimals, stable/motion flag, gross/net indicator). The indicator is set to TYPE=AUTO, AUT.FMT=FMT_1; stable readings of 93.0 kg and 110.2 kg have been seen, but the frames and status letters haven't been captured yet. `capture` ends with a summary of frame shapes, status letters and runs over time for this (README, "Hardware test mode"). Run `labourlink-scaled capture --port /dev/ttyUSB1 --seconds 120 --out r300.txt` and confirm `rinstrum-auto-a`, or switch to `generic-line`, or add a parser from the capture. Auto-transmit must already be enabled on the indicator. The station will not change indicator settings.
- **PROTAGD behaviour:** does it repeat reads while a tag is in range, what happens with two tags, what is the read range, and is the 4-digit field constant? Run `capture` on `/dev/ttyUSB0`.
- **Antenna placement** compared with the scale platform, which affects `tagWindowMs`.
- **Real scale division and noise,** which affect `stableToleranceKg` and `minLoadKg`.
- **The RS-232 adapter's USB ids:** Waveshare FT232R, 0403:6001, serial BG0427FU (in the udev rule).
- **WebKitGTK rendering on Intel HD 400.** `WEBKIT_DISABLE_DMABUF_RENDERER=1` is set in the autostart entry.
- **Station clock:** NTP sync and the condition of the CMOS battery.
- **Power-cut test** while a weighing is being recorded.
