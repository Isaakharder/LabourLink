-- ============================================================
-- Migration 006: Chapter 9 — Work Engine
-- ============================================================
-- Golden Rule: Everything that happens is an Event.
--              Everything else is a View.
--
-- Tables created (5):
--   sync_batches          — offline Android batch tracking
--   employee_day_sessions — one per employee per work date
--   work_events           — immutable append-only event log
--   work_registrations    — materialized projection of event stream
--   work_yields           — yield/piece-count records (decoupled)
--
-- Deferred FK constraints (referenced tables not yet migrated):
--   employee_day_sessions.device_config_id  → device_configs(id)   Ch.8
--   work_registrations.carrier_id           → carriers(id)          Ch.10
--   work_yields.crop_id                     → crops(id)             pending
--   work_yields.variety_id                  → varieties(id)         pending
-- Add these via ALTER TABLE ... ADD CONSTRAINT when those tables exist.
--
-- No seed data. Operational data only.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. sync_batches
-- ============================================================
-- Tracks offline Android batch submissions.
-- One row per sync operation from a device.
-- Created before work_events so events can FK back to it.
-- ============================================================

CREATE TABLE sync_batches (
  id                  SERIAL       PRIMARY KEY,
  device_id           INTEGER      NOT NULL REFERENCES devices (id),
  employee_id         INTEGER      NOT NULL REFERENCES employees (id),
  submitted_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  device_event_count  INTEGER      NOT NULL,
  earliest_event_at   TIMESTAMPTZ,
  latest_event_at     TIMESTAMPTZ,
  status              TEXT         NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'complete', 'failed', 'partial')),
  processed_at        TIMESTAMPTZ,
  error_detail        JSONB,                  -- per-event error records for 'partial' batches
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX ON sync_batches (device_id);
CREATE INDEX ON sync_batches (employee_id);

-- Background processor picks up pending batches
CREATE INDEX sync_batches_pending
  ON sync_batches (submitted_at)
  WHERE status IN ('pending', 'processing');

CREATE TRIGGER sync_batches_updated_at
  BEFORE UPDATE ON sync_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 2. employee_day_sessions
-- ============================================================
-- One row per employee per work date.
-- Opened by CLOCK_IN, closed by CLOCK_OUT or SYSTEM_AUTO_CLOSE.
-- work_date is the calendar date resolved in the site's timezone.
-- ============================================================

CREATE TABLE employee_day_sessions (
  id               BIGSERIAL    PRIMARY KEY,
  employee_id      INTEGER      NOT NULL REFERENCES employees (id),
  work_date        DATE         NOT NULL,
  site_id          INTEGER      NOT NULL REFERENCES sites (id),
  device_id        INTEGER      REFERENCES devices (id),        -- NULL = supervisor-opened
  device_config_id INTEGER,                                     -- FK device_configs(id) deferred to Ch.8 migration
  clocked_in_at    TIMESTAMPTZ  NOT NULL,
  clocked_out_at   TIMESTAMPTZ,                                 -- NULL = still clocked in
  last_event_at    TIMESTAMPTZ  NOT NULL,                       -- denorm: updated on every event arrival

  -- ─────────────────────────────────────────────────────────
  -- PERFORMANCE CACHES — NOT the source of truth.
  -- Always derivable from work_registrations:
  --
  --   total_reg_seconds =
  --     SELECT COALESCE(SUM(duration_seconds), 0)
  --     FROM   work_registrations
  --     WHERE  session_id = $id
  --       AND  is_break   = FALSE
  --       AND  is_voided  = FALSE
  --       AND  ended_at   IS NOT NULL
  --
  --   total_break_seconds =
  --     SELECT COALESCE(SUM(duration_seconds), 0)
  --     FROM   work_registrations
  --     WHERE  session_id = $id
  --       AND  is_break   = TRUE
  --       AND  is_voided  = FALSE
  --       AND  ended_at   IS NOT NULL
  --
  -- Update in the same transaction that closes a registration.
  -- Never use for payroll or compliance — always re-derive there.
  -- ─────────────────────────────────────────────────────────
  total_reg_seconds    INTEGER  NOT NULL DEFAULT 0,
  total_break_seconds  INTEGER  NOT NULL DEFAULT 0,

  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT eds_unique_employee_day
    UNIQUE (employee_id, work_date),

  CONSTRAINT eds_clockout_after_clockin
    CHECK (clocked_out_at IS NULL OR clocked_out_at > clocked_in_at),

  CONSTRAINT eds_last_event_gte_clockin
    CHECK (last_event_at >= clocked_in_at)
);

-- Live dashboard: all open sessions for a site on a given date
CREATE INDEX eds_site_date_open
  ON employee_day_sessions (site_id, work_date)
  WHERE clocked_out_at IS NULL;

-- Payroll + history: per-employee date-range queries
CREATE INDEX eds_employee_date
  ON employee_day_sessions (employee_id, work_date DESC);

CREATE TRIGGER employee_day_sessions_updated_at
  BEFORE UPDATE ON employee_day_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 3. work_events
-- ============================================================
-- IMMUTABLE APPEND-ONLY event log.
-- Every state change in the system produces exactly one row.
-- Rows are NEVER updated or deleted after insert.
-- Supervisor corrections and system actions are new rows,
-- never modifications to existing rows.
--
-- Event types and their state transitions:
--
--   CLOCK_IN           NOT_CLOCKED_IN  → IDLE
--   CLOCK_OUT          WORKING|BREAK   → NOT_CLOCKED_IN   (not an activity; closes open reg only)
--   START_ACTIVITY     IDLE|WORKING    → WORKING           (opens new reg; closes previous if any)
--   SCAN_ROW           WORKING         → WORKING           (new row, same activity; scan code confirmed)
--   CHANGE_ROW         WORKING         → WORKING           (new row, same activity; manual selection)
--   START_BREAK        WORKING         → ON_BREAK
--   START_LUNCH        WORKING         → ON_LUNCH
--   RESUME             ON_BREAK|LUNCH  → WORKING           (resumes prior activity + row context)
--   ASSIGN_CARRIER     any             → (no state change; attaches carrier to target registration)
--   REGISTER_YIELD     any             → (no state change; inserts work_yields row)
--   SUPERVISOR_CORRECT any             → (no state change; mutates materialized registration)
--   SYSTEM_GAP_FILL    server          → (inserts transfer-activity registration for uncovered gap)
--   SYSTEM_AUTO_CLOSE  server          → NOT_CLOCKED_IN   (day window end or max_reg exceeded)
-- ============================================================

CREATE TABLE work_events (
  id            BIGSERIAL    PRIMARY KEY,
  session_id    BIGINT       NOT NULL REFERENCES employee_day_sessions (id),
  employee_id   INTEGER      NOT NULL REFERENCES employees (id),      -- denorm for query speed

  event_type    TEXT         NOT NULL CHECK (event_type IN (
                  'CLOCK_IN',
                  'CLOCK_OUT',
                  'START_ACTIVITY',
                  'SCAN_ROW',
                  'CHANGE_ROW',
                  'START_BREAK',
                  'START_LUNCH',
                  'RESUME',
                  'ASSIGN_CARRIER',
                  'REGISTER_YIELD',
                  'SUPERVISOR_CORRECT',
                  'SYSTEM_GAP_FILL',
                  'SYSTEM_AUTO_CLOSE'
                )),

  occurred_at   TIMESTAMPTZ  NOT NULL,                                -- device-reported time (authoritative for ordering)
  recorded_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),                  -- server receive time (may lag for offline events)

  device_id     INTEGER      REFERENCES devices (id),                 -- NULL = supervisor or system-generated
  actor_id      INTEGER      REFERENCES employees (id),               -- NULL = employee self; non-null = supervisor or system
  is_system     BOOLEAN      NOT NULL DEFAULT FALSE,                  -- TRUE for SYSTEM_GAP_FILL, SYSTEM_AUTO_CLOSE

  -- Fast-access columns (denorm from payload for common reporting filters)
  -- Avoid parsing JSONB for the most common query predicates
  activity_id   INTEGER      REFERENCES activities (id),
  row_id        INTEGER      REFERENCES rows (id),

  payload       JSONB,                                                -- full event-specific data; schema per event_type:
  --
  -- CLOCK_IN:           {}
  -- CLOCK_OUT:          {}
  -- START_ACTIVITY:     { activity_id, row_id? }
  -- SCAN_ROW:           { scan_code, resolved_row_id, scan_type }
  -- CHANGE_ROW:         { row_id }
  -- START_BREAK:        { break_activity_id }
  -- START_LUNCH:        { lunch_activity_id }
  -- RESUME:             {}
  -- ASSIGN_CARRIER:     { carrier_id, registration_id? }
  -- REGISTER_YIELD:     { amount, unit_id, registration_id?, crop_id?, variety_id? }
  -- SUPERVISOR_CORRECT: { registration_id, correction_type, before: {}, after: {} }
  --   correction_type IN ('adjust_start','adjust_end','change_activity',
  --                       'change_row','void','insert','split')
  -- SYSTEM_GAP_FILL:    { gap_seconds, fill_activity_id, config_id }
  -- SYSTEM_AUTO_CLOSE:  { reason: 'day_window_end'|'max_reg_exceeded' }

  sync_batch_id INTEGER      REFERENCES sync_batches (id),           -- non-null for offline events
  sequence_num  INTEGER                                               -- device-assigned order within this session

  -- No updated_at — append-only; recorded_at serves as the insert timestamp
);

-- Session timeline: primary read path for Input page and audit log
CREATE INDEX we_session_time
  ON work_events (session_id, occurred_at);

-- Per-employee timeline (supervisor review, offline replay)
CREATE INDEX we_employee_time
  ON work_events (employee_id, occurred_at);

-- Supervisor correction audit
CREATE INDEX we_actor
  ON work_events (actor_id, occurred_at)
  WHERE actor_id IS NOT NULL;

-- Offline sync batch lookup
CREATE INDEX we_sync_batch
  ON work_events (sync_batch_id)
  WHERE sync_batch_id IS NOT NULL;

-- Activity-filtered reporting (performance metrics)
CREATE INDEX we_activity_time
  ON work_events (activity_id, occurred_at)
  WHERE activity_id IS NOT NULL;

-- ============================================================
-- 4. work_registrations
-- ============================================================
-- Materialized projection of the event stream.
-- Updated in the same DB transaction as the triggering event.
--
-- Source of truth for:
--   Input page        — timeline of what an employee did today
--   Live dashboard    — "what is everyone doing right now"
--   Greenhouse view   — which rows are active/completed/paused
--   Payroll           — total productive + break seconds per day
--   Performance metrics — registered_seconds and piece_count per activity
--
-- The work_events log is the immutable source of truth.
-- This table is the efficient read projection of that log.
-- Full re-derivation from work_events is always possible.
--
-- is_break is denormed from the activity's group membership:
--   set TRUE when activity_id belongs to the 'Breaks' group.
--   Do not infer break status from activity_id at query time —
--   the API sets this flag on insert to keep hot queries fast.
-- ============================================================

CREATE TABLE work_registrations (
  id                     BIGSERIAL    PRIMARY KEY,
  session_id             BIGINT       NOT NULL REFERENCES employee_day_sessions (id),
  employee_id            INTEGER      NOT NULL REFERENCES employees (id),   -- denorm
  site_id                INTEGER      NOT NULL REFERENCES sites (id),        -- denorm for reporting scope
  activity_id            INTEGER      NOT NULL REFERENCES activities (id),
  row_id                 INTEGER      REFERENCES rows (id),                  -- NULL = no location context
  carrier_id             INTEGER,                                             -- FK carriers(id) deferred to Ch.10

  started_at             TIMESTAMPTZ  NOT NULL,
  ended_at               TIMESTAMPTZ,                                         -- NULL = currently active
  duration_seconds       INTEGER,                                             -- computed on close; NULL while open

  is_break               BOOLEAN      NOT NULL DEFAULT FALSE,                 -- TRUE = activity is in 'Breaks' group
  is_voided              BOOLEAN      NOT NULL DEFAULT FALSE,                 -- TRUE = supervisor voided; excluded from all aggregates

  opened_by_event_id     BIGINT       NOT NULL REFERENCES work_events (id),
  closed_by_event_id     BIGINT       REFERENCES work_events (id),
  corrected_by_event_id  BIGINT       REFERENCES work_events (id),

  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT wr_end_after_start CHECK (
    ended_at IS NULL OR ended_at > started_at
  ),
  CONSTRAINT wr_duration_present_when_closed CHECK (
    ended_at IS NULL OR duration_seconds IS NOT NULL
  ),
  CONSTRAINT wr_duration_non_negative CHECK (
    duration_seconds IS NULL OR duration_seconds >= 0
  )
);

-- ─────────────────────────────────────────────────────────────
-- THE most critical index in the entire schema.
-- Enforces one active registration per employee at a time.
-- Powers the live dashboard query: "what is everyone doing now"
-- ─────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX wr_one_active
  ON work_registrations (employee_id)
  WHERE ended_at IS NULL AND is_voided = FALSE;

-- Payroll aggregation: per-employee, date-range, closed valid registrations only
CREATE INDEX wr_payroll
  ON work_registrations (employee_id, started_at)
  WHERE ended_at IS NOT NULL AND is_voided = FALSE;

-- Performance metrics: by activity across all employees and date ranges
CREATE INDEX wr_activity_reporting
  ON work_registrations (activity_id, started_at)
  WHERE ended_at IS NOT NULL AND is_voided = FALSE;

-- Greenhouse view: row status (active / worked today / not started)
-- Used for Not Started / Working / Completed / Paused derivation
CREATE INDEX wr_row_view
  ON work_registrations (row_id, started_at)
  WHERE row_id IS NOT NULL AND is_voided = FALSE;

-- Input page timeline: all registrations for a session in chronological order
CREATE INDEX wr_session_timeline
  ON work_registrations (session_id, started_at);

CREATE TRIGGER work_registrations_updated_at
  BEFORE UPDATE ON work_registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 5. work_yields
-- ============================================================
-- Yield / piece-count records.
-- Decoupled from work_registrations to support:
--   - Multiple partial yield submissions within one registration
--   - "Yield later" (submitted after registration is already closed)
--   - Supervisor yield entry on behalf of an employee
--
-- Rows are IMMUTABLE once created.
-- Corrections void-and-replace (void existing, insert corrected).
-- ============================================================

CREATE TABLE work_yields (
  id                   BIGSERIAL     PRIMARY KEY,
  registration_id      BIGINT        NOT NULL REFERENCES work_registrations (id),
  employee_id          INTEGER       NOT NULL REFERENCES employees (id),     -- denorm; may differ from reg.employee if supervisor-entered
  amount               NUMERIC(10,3) NOT NULL,
  unit_id              INTEGER       NOT NULL REFERENCES units (id),
  crop_id              INTEGER,                                               -- FK crops(id) deferred (no crops table yet)
  variety_id           INTEGER,                                               -- FK varieties(id) deferred
  recorded_by_event_id BIGINT        NOT NULL REFERENCES work_events (id),
  is_voided            BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- No updated_at — append-only; corrections void-and-replace

  CONSTRAINT wy_positive_amount CHECK (amount > 0)
);

-- Performance metrics: yield lookup per registration
CREATE INDEX wy_registration
  ON work_yields (registration_id)
  WHERE is_voided = FALSE;

-- Reporting: yield by employee and date
CREATE INDEX wy_employee_reporting
  ON work_yields (employee_id, created_at)
  WHERE is_voided = FALSE;

COMMIT;
