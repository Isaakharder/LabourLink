# Bin picking cycles: cutover, stop and restart

The rules are in `server/src/lib/binCycles.ts` and the tables in `migrations/074_bin_picking_cycles.sql`.

Every step that changes production needs the owner's separate approval. Keep employee credits disabled (`scale_stations.credits_enabled = false`) throughout.

## What changes, and when

| Step | Effect on production |
|---|---|
| Migration 074 applied | Four new, empty tables. Phone events may now also be `bin_rescan`. No existing row changes. |
| Server + web deployed | Nothing changes yet: with no tracking period, the existing matching rule runs unchanged, and phones are not asked to send `bin_rescan`. |
| Phone app 1.9.1 (versionCode 16) | Re-scanning the bin you're already on sends `bin_rescan`, but only while the server says picking-cycle tracking is running (`/api/mobile/me` `features.binRescan`). Otherwise it shows "Already using this bin", as before. |
| Station 0.4.3 installed | Shows "Not credited: already weighed" when the server reports `noPickingCycle`. Against an older server the flag is absent and nothing changes. |
| **Cutover**: a tracking period is started | From that moment, picking cycles decide every weighing. Phone scans before the start never open a cycle. Weighings before it keep their decisions. |

## Order

1. **Apply migration 074** in the Supabase SQL Editor, **before** merging. Code that expects a table before its migration runs crashes the API.
   - Run it as one script, outside working hours. Replacing the phone-event type constraint briefly locks `mobile_time_events` while it re-checks existing rows, which holds phone syncs for those seconds.

   Then check:
   ```sql
   select count(*) from bin_cycle_tracking;  -- 0: no tracking period
   select count(*) from bin_cycles;          -- 0
   ```
2. **Merge the PR.** Railway deploys the Server and Web services. Then verify:
   - `/api/health` returns 200;
   - a weighing is still matched by the existing rule;
   - the Scale Weighings page loads.
3. **Release phone app 1.9.1 (versionCode 16)** through Google Play, only after step 2.
   - Phones on the old app keep working, but a picker on one of them who keeps the same bin after weighing must switch away and back to start a new cycle.
4. **Install station 0.4.3** on the NUC with `install-0.4.3.sh`, which backs up the NUC first. This can happen any time after step 2.
5. **Cutover**, at the start of a workday, **before the first phone bin scan**:
   ```sql
   insert into bin_cycle_tracking (started_at, note) values (now(), 'Cutover approved by <name>, <date>');
   ```
   - If an employee is already on a bin at that moment, their earlier scan doesn't count.
   - On the new app they re-scan the bin. On the old app they switch to another bin or activity and back.
6. **Verify** (read-only):
   - a bin's first scan opens a cycle (Scale Weighings → Open picking cycles shows **Filling**);
   - switching bins shows **Awaiting weighing**;
   - the weighing is credited and its cycle closes;
   - weighing the same bin again without a scan shows "Not credited: already weighed";
   - re-scanning the same bin (new app) opens a new cycle.

## Existing data

- **Not changed:** trial weighings, registered bins and audit rows. No historical cycle is inferred.
- **The 57 bins with unused phone scans from before the cutover:** those scans never count. Every bin starts with no open cycle.
- **Bin 43's 4.0 kg test weighing:** voiding it is a separate, approved action. Use "Void this credit" on the Scale Weighings page.

## Resolving a needs-review cycle

**When it happens:** a weighed cycle that more than one employee scanned goes to **Needs review**, and nobody is credited.

**How to resolve it (Administrator):**
1. Open the weighing on Scale Weighings. It shows every scan in the cycle: who and when.
2. Choose **Resolve: choose the employee**, pick one of those employees, and give a reason.

**What it does:**
- The weighing is credited exactly once.
- The cycle records who resolved it, when, why and the previous status.
- Repeating the same request changes nothing.
- A resolved cycle can't be resolved again.
- Late phone scans and background reconciliation never change the credit.
- The credit can still be voided.

**What can't be resolved:** an open (not yet weighed) needs-review cycle. Wait for its weighing, or use **Close without weighing** if the bin was emptied.

## Stopping tracking (rollback) and restarting

- **Stop:**
  ```sql
  update bin_cycle_tracking set stopped_at = now() where stopped_at is null;
  ```
  - Within 5 minutes (the sweep), every open cycle is closed without weighing ("tracking was stopped"). Nobody is credited for those cycles.
  - Exception: a weighing made **before** the stop that reaches LabourLink only afterwards (the station was offline) still closes the cycle that was open at its time, keeps its original weighing time, and is credited as usual. Scans after that weighing stay in a cycle closed at the stop.
  - Phones stop being asked to send `bin_rescan` while stopped.
  - New weighings return to the existing rule, which **never uses a phone scan from before the stop**. Old scans can't credit anything.
  - Weighings already decided by cycles keep their outcome.
- **Restart:**
  ```sql
  insert into bin_cycle_tracking (started_at, note) values (now(), 'Restarted by <name>, <date>');
  ```
  - Only scans after the restart open cycles.
  - Cycles closed by the stop stay closed.
- **Roll back the code:** revert the merge commit and let Railway redeploy.
  - The reverted server doesn't know about stops, so the old rule could again use stale scans. Do this only with credits disabled.
  - Keep migration 074. In particular, never restore the old phone-event type constraint: phones may still hold queued `bin_rescan` events, and an older constraint would stop their sync.
  - With 074 kept, the reverted server records those events as rejected and the phone's sync keeps moving.
- **Roll back the station:** `sudo apt install --allow-downgrades ./labourlink-scale_0.4.2_amd64.deb`.
  - 0.4.2 ignores the extra `no_picking_cycle` column.
  - `install-0.4.3.sh` also left a full backup in `/root/llscale-backup-<date>`.

## Compatibility

- **Stations 0.4.0 to 0.4.2:** they ignore `noPickingCycle`, so a re-weigh shows "Awaiting employee assignment" and, 24 h later, "Not credited". Weighing and credits are decided on the server either way.
- **Offline station uploads:** each weighing is decided by its own `weighed_at`:
  - before the cutover: the old rule;
  - inside a period: picking cycles;
  - after a stop: the old rule, with no pre-stop scans.

  A weighing made before a stop but uploaded after it still closes, and is credited for, the cycle open at its time.
- **Phones:**
  - Old app with new server: no rescans, everything else unchanged.
  - New app with old server, or with tracking not running: the server doesn't advertise `binRescan`, so the app sends none.
- **Greenhouses without LabourLink Scale:**
  - No tracking period is ever started, so picking cycles never run.
  - Phones are never asked to send `bin_rescan`.
  - The open-cycles panel stays hidden.
  - Clock-in/out, jobs, bin and row scanning, breaks, offline sync, payroll and reports are unchanged (tested in `test:bin-cycles-no-scale` and the existing suites).

## Known limits

- **Needs review:** a cycle with more than one employee is credited only after an administrator resolves it. Open ones can't be resolved until weighed.
- **Clock problems:** phone scans with a flagged phone clock never open a cycle, the same as before.
- **Shared bins:** two pickers deliberately sharing one bin always need a resolution, which credits all of the bin's weight to one of them.
