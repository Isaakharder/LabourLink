-- App-store reviewer access, served ONLY by a separate demo deployment of
-- LabourLink (its own database and API service, fictional data only) — never
-- by the production instance. LabourLink is single-tenant (org_settings is a
-- single row; no table carries an organization id), so the "demo
-- organization" is a whole separate instance: a reviewer phone paired here
-- talks only to the demo API, whose database holds no real employee data.
--
-- Applying this migration to production is harmless: both tables stay empty
-- there, and POST /api/pairing/reviewer refuses to run unless the server is
-- started with LABOURLINK_DEMO_INSTANCE=true AND demo_instance has its row
-- (written only by `npm run demo:seed`, which refuses to run against a
-- database that already has employees).

-- Single-row marker: "this database is a demo instance".
create table demo_instance (
  id boolean primary key default true,
  constraint demo_instance_single_row check (id),
  label text not null,
  seeded_at timestamptz not null default now()
);

-- Reusable reviewer pairing codes. Unlike the 6-digit admin-approved pairing
-- code (pairing_requests — unchanged), a reviewer code does not expire on its
-- own and can pair several devices; it stops working only when revoked
-- (`npm run reviewer:credentials -- revoke|rotate`) or when max_devices is
-- reached. Only the SHA-256 of the normalized code is stored — the code is
-- high-entropy and generated server-side, so a fast hash is sufficient (same
-- approach as integration_tokens).
create table reviewer_pairing_credentials (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  code_hash text not null,
  code_hint text not null, -- last 4 characters, to tell codes apart in listings
  max_devices integer not null default 25 check (max_devices between 1 and 500),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
create unique index idx_reviewer_pairing_credentials_hash on reviewer_pairing_credentials (code_hash);

-- Which reviewer code (if any) paired a device — lets revoking a code also
-- deactivate every device it paired. Null for every normally paired device.
alter table devices
  add column paired_via_reviewer_credential_id uuid references reviewer_pairing_credentials(id);
create index idx_devices_reviewer_credential on devices (paired_via_reviewer_credential_id)
  where paired_via_reviewer_credential_id is not null;
