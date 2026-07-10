-- ============================================================
-- Migration 026 — Dedicated mobile bearer sessions
-- ============================================================
-- Separate session mechanism for native (Android) clients — NOT the
-- same rows as the browser `sessions` table (023_users_and_sessions.sql).
--
-- The bearer token returned to a mobile client is `<token_id>.<secret>`.
-- token_id is a public lookup key; secret is generated with 32 bytes of
-- CSPRNG output and is NEVER stored — only its SHA-256 digest
-- (token_hash) is. Copying a row out of this table (e.g. via a backup)
-- does not yield a usable credential: the secret itself, not just its
-- hash, would be required to authenticate, and hashes are one-way.
-- ============================================================

BEGIN;

CREATE TABLE mobile_sessions (
  id            BIGSERIAL    PRIMARY KEY,
  token_id      TEXT         NOT NULL UNIQUE,
  token_hash    TEXT         NOT NULL,
  user_id       INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  company_id    INTEGER      NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  device_id     TEXT,
  device_name   TEXT,
  app_version   TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ  NOT NULL,
  revoked_at    TIMESTAMPTZ
);

-- Fast "list this user's active mobile sessions" for the admin panel
CREATE INDEX mobile_sessions_user_active_idx ON mobile_sessions (user_id) WHERE (revoked_at IS NULL);
CREATE INDEX ON mobile_sessions (expires_at);

COMMIT;
