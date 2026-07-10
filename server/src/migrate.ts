import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

interface MigrationFile {
  filename: string;
  fullPath: string;
}

// Newest migration known to have been applied via docker-entrypoint-initdb.d
// on any database created before this runner existed. Used once, to backfill
// schema_migrations on upgrade without re-running (non-idempotent) old files.
//
// Convention: every migration ADDED AFTER this cutoff must be additive-only
// (CREATE TABLE/ALTER TABLE ADD COLUMN/CREATE INDEX/INSERT — no DROP). That's
// what makes it safe for the "already exists" fallback below to treat a
// duplicate-object error as "already applied" instead of a real failure.
const BASELINE_LAST_FILE = '022_crop_locations.sql';

function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), '..', 'database', 'migrations');
}

function listMigrationFiles(): MigrationFile[] {
  const dir = migrationsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => ({ filename, fullPath: path.join(dir, filename) }));
}

async function ensureTrackingTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// A database provisioned before this runner existed has no schema_migrations
// rows at all, even though 001-022 already ran via docker-entrypoint-initdb.d.
// Detect that case via a sentinel table and backfill without re-executing.
async function ensureBaseline(pool: Pool, files: MigrationFile[]): Promise<void> {
  const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
  if (countRows[0].n > 0) return;

  const { rows: sentinelRows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables WHERE table_name = 'employees'
     ) AS exists`,
  );
  if (!sentinelRows[0].exists) return; // genuinely fresh database

  const baseline = files.filter((f) => f.filename <= BASELINE_LAST_FILE);
  for (const f of baseline) {
    await pool.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
      [f.filename],
    );
  }
  console.log(`[migrate] Backfilled ${baseline.length} pre-existing migration(s) as already applied.`);
}

export async function runMigrations(pool: Pool): Promise<void> {
  const files = listMigrationFiles();
  await ensureTrackingTable(pool);
  await ensureBaseline(pool, files);

  const { rows: appliedRows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set<string>(appliedRows.map((r) => r.filename));
  const pending = files.filter((f) => !applied.has(f.filename));

  if (pending.length === 0) {
    console.log('[migrate] No pending migrations.');
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(file.fullPath, 'utf8');
    try {
      // Each file is sent as a single multi-statement command; Postgres
      // implicitly wraps it in one transaction unless the file already
      // manages its own BEGIN/COMMIT (all files here do one or the other).
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file.filename]);
      console.log(`[migrate] Applied ${file.filename}`);
    } catch (err) {
      // A fresh (empty) database has docker-entrypoint-initdb.d run every
      // .sql file present at container-creation time, including migrations
      // added after this runner existed — so a file after BASELINE_LAST_FILE
      // can legitimately already be applied even though schema_migrations
      // has no row for it yet. That's only safe to assume for additive-only
      // migrations (no DROP), which is why files at/before BASELINE_LAST_FILE
      // are never routed through this fallback — they're handled exclusively
      // by ensureBaseline's skip-without-executing path instead.
      const pgCode = (err as { code?: string }).code;
      const isDuplicateObjectError = pgCode !== undefined &&
        ['42P07', '42701', '42710', '42P06'].includes(pgCode);
      if (file.filename > BASELINE_LAST_FILE && isDuplicateObjectError) {
        await pool.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file.filename],
        );
        console.log(`[migrate] ${file.filename} objects already exist — marking as applied.`);
        continue;
      }
      console.error(`[migrate] Failed applying ${file.filename}`);
      throw err;
    }
  }
}

if (require.main === module) {
  // Explicit invocation: `npm run migrate`
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { db } = require('./db');
  runMigrations(db)
    .then(() => {
      console.log('[migrate] Done.');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
