-- One active push delivery destination per device — an Android APK install
-- registers an FCM token, an installed PWA registers a Web Push
-- subscription (see server/src/routes/mobilePush.ts). Never both for the
-- same device at once: a physical phone is either running the Capacitor
-- app or a browser/PWA install, not both simultaneously.
--
-- Kept as its own table rather than nullable columns on devices itself
-- (001_initial_schema.sql) — devices already models "one row per physical
-- device" for pairing/assignment purposes; bolting four push-specific
-- nullable columns on there would touch every existing devices read/write
-- for a concern only the messaging feature needs.
create table device_push_registrations (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  platform text not null check (platform in ('android_fcm', 'web_push')),

  fcm_token text,
  web_push_endpoint text,
  web_push_p256dh text,
  web_push_auth text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set when a send attempt confirms the token/subscription is no longer
  -- valid (FCM's "unregistered" error, or a Web Push 404/410) — a disabled
  -- row is skipped by future sends but kept for history rather than deleted.
  disabled_at timestamptz,

  constraint chk_device_push_registrations_fields check (
    (platform = 'android_fcm' and fcm_token is not null and web_push_endpoint is null
       and web_push_p256dh is null and web_push_auth is null) or
    (platform = 'web_push' and web_push_endpoint is not null and web_push_p256dh is not null
       and web_push_auth is not null and fcm_token is null)
  )
);

create index idx_device_push_registrations_device on device_push_registrations(device_id);
-- At most one active (not-yet-disabled) registration per device — a
-- re-register (token refresh, or switching platform) disables whatever was
-- active and inserts a fresh row (see mobilePush.ts's POST /push/register),
-- rather than accumulating duplicates this index would otherwise reject.
create unique index idx_device_push_registrations_active_per_device
  on device_push_registrations(device_id) where disabled_at is null;
