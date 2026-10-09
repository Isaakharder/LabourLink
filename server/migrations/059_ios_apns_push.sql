-- iOS push: the iPhone app registers its raw APNs device token (platform
-- 'ios_apns'), delivered directly through Apple's APNs HTTP/2 API by
-- server/src/lib/apns.ts — no Firebase on iOS. Android ('android_fcm') and
-- browser ('web_push') registrations are unchanged.
--
-- apns_environment records which APNs gateway accepted the token: Xcode/debug
-- builds get sandbox tokens, TestFlight/App Store builds get production
-- tokens, and the app itself can't tell which it is. Null until the first
-- successful send; pushDelivery.ts tries production first and falls back to
-- sandbox on BadDeviceToken, then remembers the answer here.

alter table device_push_registrations
  add column apns_token text,
  add column apns_environment text
    constraint chk_device_push_registrations_apns_environment
    check (apns_environment in ('production', 'sandbox'));

-- The inline platform check from 028 got Postgres's default name.
alter table device_push_registrations
  drop constraint device_push_registrations_platform_check,
  add constraint device_push_registrations_platform_check
    check (platform in ('android_fcm', 'web_push', 'ios_apns'));

alter table device_push_registrations
  drop constraint chk_device_push_registrations_fields,
  add constraint chk_device_push_registrations_fields check (
    (platform = 'android_fcm' and fcm_token is not null and web_push_endpoint is null
       and web_push_p256dh is null and web_push_auth is null and apns_token is null) or
    (platform = 'web_push' and web_push_endpoint is not null and web_push_p256dh is not null
       and web_push_auth is not null and fcm_token is null and apns_token is null) or
    (platform = 'ios_apns' and apns_token is not null and fcm_token is null
       and web_push_endpoint is null and web_push_p256dh is null and web_push_auth is null)
  );
