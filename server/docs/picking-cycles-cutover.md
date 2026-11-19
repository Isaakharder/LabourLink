# Bin picking cycles: cutover and rollback

The rules are in `server/src/lib/binCycles.ts` and the tables in `migrations/074_bin_picking_cycles.sql`.

Every step that changes production needs the owner's separate approval. Keep employee credits disabled (`scale_stations.credits_enabled = false`) throughout.

## What changes, and when

| Step | Effect on production |
|---|---|
| Migration 074 applied | Four new, empty tables. No existing row changes. |
| Server + web deployed | Nothing changes yet: while `bin_cycle_tracking` is empty, the existing matching rule runs unchanged. The open-cycles panel stays hidden. |
| Station 0.4.3 installed | Shows "Not credited: already weighed" when the server reports `noPickingCycle`. Against an older server the flag is absent and nothing changes. |
| **Cutover**: one row inserted into `bin_cycle_tracking` | From that moment, picking cycles decide every weighing. Phone scans before the cutover never open a cycle. Weighings before it keep their decisions. |

## Cutover order

1. **Apply migration 074** in the Supabase SQL Editor, **before** merging. Code that expects a table before its migration runs crashes the API. Then check:
   ```sql
   select count(*) from bin_cycle_tracking;  -- 0: tracking is off
   select count(*) from bin_cycles;          -- 0
   ```
2. **Merge the PR.** Railway deploys the Server and Web services. Then verify:
   - `/api/health` returns 200;
   - a weighing is still matched by the existing rule;
   - the Scale Weighings page loads.
3. **Install station 0.4.3** on the NUC with `install-0.4.3.sh` (it backs up the NUC first). This can happen any time after step 2.
4. **Cutover**, at the start of a workday, **before the first phone bin scan**:
   ```sql
   insert into bin_cycle_tracking (started_at, note)
   values (now(), 'Cutover approved by <name>, <date>');
   ```
   If an employee is already on a bin at that moment, their earlier scan doesn't count, and re-scanning the same bin sends nothing. They must switch to another bin or activity and back, or that bin's next weighing is not credited.
5. **Verify** (read-only):
   - the first scan of a bin opens a cycle (Scale Weighings → Open picking cycles shows **Filling**);
   - switching bins shows **Awaiting weighing**;
   - the bin's weighing is credited and its cycle closes;
   - weighing the same bin again without a scan shows "Not credited: already weighed" on the station and "Picking cycle: None" in the weighing detail.

## Existing data

- **Not changed:** trial weighings, registered bins and audit rows. No historical cycle is inferred.
- **The 57 bins with unused phone scans from before the cutover:** those scans are older than `started_at`, so they never count. Every bin starts with no open cycle.
- **Bin 43's 4.0 kg test weighing:** voiding it is a separate, approved action. Use "Void this credit" on the Scale Weighings page.

## Rollback

- **Stop cycle tracking, keeping the code:**
  ```sql
  delete from bin_cycle_tracking;
  ```
  - New weighings return to the previous rule. That rule counts any scan since the bin's previous weighing (or the last 24 h), so old scans can again credit a bin.
  - Weighings already decided by cycles keep their outcome.
  - The cycle tables stay, as audit history.
- **Roll back the code:** revert the merge commit on `master` and let Railway redeploy. Do this after the step above.
  - The 074 tables are harmless without the code that reads them.
  - Drop them only if you're sure: `drop table bin_cycle_events, bin_scans, bin_cycles, bin_cycle_tracking;`.
- **Roll back the station:** `sudo apt install --allow-downgrades ./labourlink-scale_0.4.2_amd64.deb`.
  - 0.4.2 ignores the extra `no_picking_cycle` column.
  - `install-0.4.3.sh` also left a full backup in `/root/llscale-backup-<date>`.

## Known limits

- **Same bin after weighing:** a picker who keeps the bin they are already on after it is weighed must switch away and back, because the phone sends nothing for a re-scan of the current bin. Until then, that bin's next weighing is not credited, which is the safe direction. A small phone change would fix this; it is not part of this change.
- **Needs review:** a cycle with more than one employee is never credited. There is no tool to assign its kilograms. "Close without weighing" is only for a bin emptied or abandoned before it was weighed.
- **Clock problems:** phone scans with a flagged phone clock never open a cycle, the same as before.
