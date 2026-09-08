-- Fourth source value: breakReconciliation.ts's automatic-break "after"
-- continuation gets an honest break_reconciliation source instead of
-- silently defaulting to the table's own 'manual' default (its INSERT
-- previously omitted the `source` column entirely) — indistinguishable from
-- a real tap or a genuine admin manual entry, which is exactly wrong when
-- the row being split was itself already a synthetic midnight_rollover
-- continuation. Distinct from 'auto' (already means "the break entry
-- itself") and from 'midnight_rollover' (not a midnight event).
--
-- Unrelated to midnight rollover/cutoff behavior — this file originally
-- also added a runaway-shift safety-cutoff mechanism (extra time_entries
-- columns, an org_settings threshold, a partial index) that has since been
-- superseded by a stricter "always cut off at local midnight, never
-- continue" design (see midnightCutoff.ts) that makes that mechanism
-- structurally unnecessary. That mechanism was never applied to production
-- and has been removed from this migration entirely; only this
-- independent, still-needed fix remains.
alter table time_entries
  drop constraint time_entries_source_check,
  add constraint time_entries_source_check
    check (source in ('manual', 'auto', 'midnight_rollover', 'break_reconciliation'));
