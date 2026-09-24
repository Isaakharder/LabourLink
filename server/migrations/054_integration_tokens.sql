-- Hashed bearer tokens for read-only machine-to-machine integrations
-- reading LabourLink data from outside the app — the first and only
-- consumer today is Productive TV (see server/src/routes/integrations.ts),
-- an external Windows PC pulling per-employee Winding & Pruning stems/hour
-- speed to fold into its own dashboard slide.
--
-- Modeled on greenhouse_displays' hashed-token scheme
-- (server/src/lib/displayToken.ts, 016_greenhouse_displays.sql) but
-- deliberately narrower: unlike greenhouse_displays' display_key_plaintext
-- (036_greenhouse_display_key_plaintext.sql), no plaintext copy is ever
-- persisted here — this token protects live employee speed data, not a
-- TV's own bookmarked URL, so if it's lost the only recovery path is
-- deactivating this row and issuing a new one via
-- `npm run create-integration-token`, never reading it back out of the
-- database. It's also sent as an Authorization: Bearer header, never
-- embedded in a URL the way a display token is, so it never lands in a
-- server access log or browser history.
create table integration_tokens (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- Hot path: every authenticated request hashes its bearer token and looks
-- this up. Unique also backstops a hash collision ever granting
-- cross-integration access.
create unique index idx_integration_tokens_hash on integration_tokens (token_hash);
