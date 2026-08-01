# Migrations

Plain SQL files, applied in order by `npm run migrate` (`src/migrate.ts`), tracked
by filename in a `schema_migrations` table. **Never edit or renumber an
applied migration file** — `migrate.ts` skips anything already recorded
without re-reading it, so an edit only affects fresh installs that haven't
run it yet, silently diverging from every environment that has. Add a new
numbered file for any change instead.

## Seed data (`003_activities_and_time_entries.sql`)

That migration inserts two starter activities, "Winding & Pruning" and
"Picking Peppers." No application code depends on their names or IDs —
they're ordinary rows an admin is free to rename, deactivate, or stop using
from the Activities page. Because migration history can't be edited or
reversed, any fresh install running the full migration set from scratch will
always get these two rows; that's accepted as normal first-run seed data, not
a dependency. Don't add another migration seeding hardcoded rows the same
way — if a fresh-install starter dataset is ever needed again, prefer a
separate, explicitly-invoked setup script (like `create-admin`) over an
unconditional insert baked into a schema migration.
