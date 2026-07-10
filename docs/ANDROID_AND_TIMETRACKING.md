# Android App Preparation & Time-Tracking Readiness

This document covers what's already in place for a future Android employee
app, what the app needs to bring, and an audit of the existing time-tracking
schema/API. **No Android app or missing time-tracking feature is built in
this pass** — this is the groundwork and the plan.

---

## 1. API base path & versioning

All application routes are mounted twice, on the same router instance:

- `/api/...` — existing path, used unchanged by the current React web app.
- `/api/v1/...` — identical routes, new stable versioned path. **The Android
  app should use `/api/v1/...`.**

`/health` stays unversioned (liveness/readiness checks conventionally are).

Both paths currently resolve to identical behavior — there is no divergence
to worry about. If a future breaking change is ever needed, it would land as
a new `/api/v2` router mounted alongside, leaving `/api/v1` (and the Android
app) untouched.

## 2. Authentication for Android

**Decision: a dedicated, hash-stored mobile session mechanism (`mobile_sessions`
table) — separate from the browser cookie session, but reusing the exact
same identity/permission/company-scoping resolution the browser path uses.**

An earlier version of this feature returned the raw `express-session` id
(`req.sessionID` — the same plaintext value stored as the `sid` primary key
in the browser `sessions` table) as a "bearer token," and a middleware
re-signed *any* client-supplied value using the server's own
`SESSION_SECRET` on every request. That construction was reviewed and
rejected: anyone with read access to the `sessions` table (e.g. a
`pg_dump` backup) could take a `sid` value and successfully authenticate as
that user with no separate secret, since the live server would sign it for
them. It has been replaced with the design below.

**Current design** (`database/migrations/026_mobile_sessions.sql`,
`server/src/lib/mobileSessions.ts`, `server/src/middleware/mobileAuth.ts`):

- A mobile bearer token is `<tokenId>.<secret>` — `tokenId` is a public
  lookup key; `secret` is 32 bytes of CSPRNG output
  (`crypto.randomBytes(32)`) and is **never stored**. Only
  `SHA-256(secret)` is written to `mobile_sessions.token_hash`.
- `POST /api/v1/auth/mobile-login` (email + password, optionally
  `deviceId`/`deviceName`/`appVersion`) verifies credentials through the
  *same* `checkCredentials()` helper `/auth/login` uses (same account
  lockout, same failed-attempt tracking — one implementation, not two),
  creates a `mobile_sessions` row, and returns `{ token, expiresAt }` in the
  JSON body. It never sets a cookie and never touches `express-session`.
- On each request, `middleware/mobileAuth.ts` reads
  `Authorization: Bearer <token>`, looks up `mobile_sessions` by `tokenId`,
  and compares `SHA-256(presented secret)` against the stored hash using
  `crypto.timingSafeEqual` (constant-time — see Section 2a). A row copied
  out of the database (backup, replication, direct read access) cannot be
  replayed as a token: the comparison requires the original secret, and a
  SHA-256 hash cannot be reversed to recover it.
- Verification also checks `revoked_at IS NULL`, `expires_at > NOW()`, and
  the user's live `is_active` flag — then rolls `expires_at` forward
  another 8 hours (same rolling-TTL policy as the browser session) and
  updates `last_used_at`.
- `requireAuth` (`middleware/auth.ts`) now checks `if (req.user) { next(); return; }`
  first — if `mobileAuth` already populated `req.user` from a valid bearer
  token, the existing cookie-session lookup is skipped; otherwise it falls
  back to the browser session check unchanged. Both paths converge on the
  identical `AuthenticatedUser` shape, so every downstream route,
  `requirePermission` check, and company-scoping helper behaves identically
  regardless of which credential type authenticated the request.
- `POST /api/v1/auth/mobile-logout` (bearer-authenticated) revokes exactly
  the one `mobile_sessions` row backing the presented token. It does **not**
  touch the browser `sessions` table — a mobile client must call this route,
  not `/auth/logout` (which destroys the caller's `express-session`, not a
  mobile session).

**Why not raw cookies for Android:** technically possible (an
`OkHttp`/`Retrofit` client can use a persistent `CookieJar`), but cookie jar
lifecycle management on Android is easy to get subtly wrong, and it
couples the mobile client to cookie semantics designed for browsers — and,
as above, the *browser* session id itself is not something that should
double as a distributable bearer credential in the first place. **Why not a
JWT:** a self-verifying JWT can't be revoked before its exp claim without a
denylist — which just becomes this same kind of table anyway, with none of
this design's simplicity.

### 2a. Answers to the specific security questions raised in review

| # | Question | Answer |
|---|---|---|
| 1 | Same identifier as the browser cookie, or separate? | **Separate.** `mobile_sessions` is a distinct table with its own random token, unrelated to `express-session`'s `sid`. |
| 2 | Is the full bearer token stored in Postgres in plain/readable form? | **No.** Only `token_hash` (SHA-256 of the secret half) is stored. The secret itself is never written to the database. |
| 3 | Could DB read access alone produce a usable token? | **No.** `token_hash` cannot be reversed to the secret; without the secret, `crypto.timingSafeEqual` will not match. |
| 4 | Does returning the token weaken the browser session? | **No.** `/mobile-login` never touches `express-session`, never sets a cookie, and reads no browser session state. |
| 5 | Independently revocable? | **Yes.** Two separate tables (`sessions` vs `mobile_sessions`), each with its own `revoked_at`. |
| 6 | Can an admin revoke one specific device without logging out all browser sessions? | **Yes** — `POST /api/users/:id/mobile-sessions/:sessionId/revoke` revokes exactly one `mobile_sessions` row. |
| 7 | Does logout revoke both the cookie session and the presented bearer session? | `POST /auth/logout` destroys only the browser session; `POST /auth/mobile-logout` revokes only the presented mobile session — a client must call the one matching its own credential type. Both are always available: an admin can additionally force-revoke via `/api/users/:id/sessions/revoke-all` and `/api/users/:id/mobile-sessions/revoke-all`. |
| 8 | CSPRNG with sufficient entropy? | **Yes** — `crypto.randomBytes(32)` (256 bits) for the secret, `crypto.randomBytes(16)` (128 bits) for the public token id. |
| 9 | Timing-safe comparison? | **Yes** — `crypto.timingSafeEqual` on the two SHA-256 digests, with an explicit length check first (mismatched-length buffers throw rather than leak via comparison). |
| 10 | Excluded from logs? | **Yes** — no code path logs `req.headers.authorization`; nginx uses the default `combined` log format, which does not include the `Authorization` header. |
| 11 | Expiry/renewal policy? | 8-hour rolling TTL, identical to the browser session policy — `expires_at` extends on every successful verification. |
| 12 | Are inactive/locked/deactivated users blocked immediately? | `mobileAuth` re-checks `users.is_active` on **every** request (not just at token issuance), so a deactivated account is rejected on its very next call even with an otherwise-valid, unexpired token. Deactivation and password reset also proactively revoke all of that user's `mobile_sessions` rows (`server/src/routes/users.ts`). |

**Android-side requirements (not built, documented for the app team):**

- Store the token only in `EncryptedSharedPreferences`
  (`androidx.security.crypto`, Keystore-backed) — never plain
  `SharedPreferences`, never written to logs, never put in a URL or query
  string.
- Treat a `401` response as "session expired/revoked" — clear the stored
  token and force re-login.
- On logout, call `POST /api/v1/auth/mobile-logout` (revokes the session
  server-side) *and* clear the local token — clearing local storage alone
  leaves the session valid server-side until it naturally expires.
- See `docs/DEPLOYMENT.md` for the plain-HTTP transport warning that
  applies to this token exactly as much as it applies to browser cookies.

### Future: PIN-based kiosk login

The schema already has `employee_credentials.pin_hash` (set via
`server/src/routes/employees.ts`, e.g. `POST /api/employees/:id/pin`) and a
`devices` table (`identifier`, `is_shared`) intended for a shared/kiosk
tablet where an employee enters a PIN rather than an email+password. **No
HTTP login route exists yet for this** — it's unused infrastructure. This is
the natural mechanism for "one employee must not submit as another without
re-authentication" on a shared device: a PIN re-entry before any clock
action, tied to `device_assignments`, not a long-lived login. Recommended
for a later pass, once the online-only single-employee-per-account flow is
working.

## 3. Consistent JSON errors

Now enforced globally (`server/src/index.ts`): every 400/401/403/404/409/500
response is JSON (`{ "error": "..." }`), including previously-unhandled
cases — unmatched routes and uncaught exceptions used to fall through to
Express's default HTML pages; they now go through a global 404 handler and a
global error handler instead. The Android app can safely assume every
response is JSON and never has to guard against an HTML login/error page
being returned to a fetch call.

## 4. Which existing routes the Android app can use as-is

All under `/api/v1/...`, all currently `requireAuth`-protected unless noted:

| Route | Purpose |
|---|---|
| `POST /auth/mobile-login` | **Android should use this**, not `/auth/login` — email + password (+ optional `deviceId`/`deviceName`/`appVersion`) in, `{ token, expiresAt }` out. PIN login is future work, see above. |
| `POST /auth/mobile-logout` | Revokes the presented mobile session only |
| `GET /auth/me` | Current user + permissions — works with either credential type (call after login/on app start to validate the session) |
| `POST /auth/login` | Browser-only cookie login — not for the Android app |
| `POST /auth/logout` | Browser-only cookie session destroy — not for the Android app |
| `GET /setup/status` | Public — whether the system needs initial setup (not relevant to a per-employee app, but useful for a connectivity check) |
| `POST /work/clock-in` | Start the work day |
| `POST /work/clock-out` | End the work day |
| `POST /work/start-activity` | Change activity |
| `POST /work/change-location` | Select/change greenhouse location & row |
| `POST /work/start-break` | Start a break |
| `POST /work/start-lunch` | Start a lunch break |
| `POST /work/resume` | Resume work after a break/lunch |
| `GET /work/employees/:employeeId/day` | Current day's session/registrations for one employee |
| `GET /work/input-dashboard` | Supervisor-facing dashboard data |
| `GET /employees`, `/locations`, `/activities`, `/location-groups`, `/crops`, `/varieties` | Reference/lookup data the app needs for pickers (locations, rows, activities, crops) |

Admin-only (web app, `users:manage` permission) — device/session management
for supervisors handling a lost or reassigned phone, not called by the
Android app itself:

| Route | Purpose |
|---|---|
| `GET /users/:id/mobile-sessions` | List a user's active mobile sessions (device name, app version, last used, expiry) |
| `POST /users/:id/mobile-sessions/:sessionId/revoke` | Revoke one specific device's session |
| `POST /users/:id/mobile-sessions/revoke-all` | Revoke all of a user's mobile sessions (e.g. lost phone) |
| `GET /users/:id/sessions`, `POST /users/:id/sessions/revoke-all` | Same, for browser sessions — independent of the mobile ones above |

## 5. New endpoints time tracking will still need

Not built in this pass — flagged from the audit below:

- **Offline sync ingestion** — a batch endpoint accepting an array of
  device-generated events (using the existing `sync_batches` and
  `work_events.sync_batch_id`/`sequence_num` columns, which already exist in
  the schema but have no route). Must validate `sequence_num` ordering per
  device and reject/no-op exact duplicate device-generated IDs.
- **Supervisor correction routes** — `work_events` already has a
  `SUPERVISOR_CORRECT` event type with a documented payload shape
  (`{registration_id, correction_type, before, after}`), but no route
  creates one yet.
- **Connectivity check endpoint** — `GET /health` already works for this
  (no auth required, fast, already DB-backed) — the app should hit it before
  showing a login screen and periodically thereafter to drive an
  offline/unavailable UI state.

## 6. Android connectivity requirements (for the future app, documented now)

- The phone must be on the same greenhouse Wi-Fi/local network as the server
  — there is no internet-routable path to this deployment by design.
- The server computer needs a fixed IP (Section 3 of `DEPLOYMENT.md` —
  router DHCP reservation preferred).
- **The app must not hardcode a server IP into the APK.** Store the server
  address (`http(s)://host:port`) in app settings, configurable per
  installation/device, since different greenhouses (or a future second
  site) will have different IPs.
- **Test connectivity before login**: `GET /health` against the configured
  address; show a clear "server unavailable" state (not a generic network
  error) if it fails or times out, distinct from "wrong credentials."
- **Offline queue**: greenhouse Wi-Fi may drop. The app needs a local queue
  (e.g. Room database) of pending work events, replayed via the future sync
  endpoint (Section 5) once connectivity returns.
- **Authoritative timestamps**: when online, clock in/out and activity
  changes should use the server's `NOW()` (already how `work_events.recorded_at`
  works server-side) rather than trusting the device clock — the device
  clock is only used to timestamp `occurred_at` for offline-queued events,
  which the server should treat as claimed-but-not-authoritative until
  reconciled.
- **Device-generated unique IDs**: every offline-queued event needs a
  client-generated UUID so the sync endpoint can detect and no-op exact
  duplicate submissions (e.g. a retried batch after a dropped connection) —
  this is what `sync_batches`/`sequence_num` are already shaped for.
- **No cross-employee submission without re-auth**: a logged-in session
  belongs to one employee/user. Any "switch employee" action on a shared
  device must force a fresh login (or, once built, a PIN re-entry — see
  Section 2) rather than silently attributing a new clock action to a
  different employee under an existing session.

---

## 7. Time-tracking readiness audit

Read directly from `database/migrations/002_employee_domain.sql`,
`006_work_engine.sql`, `009_location_domain_refactor.sql`, and
`server/src/routes/work.ts`.

| Capability | Status | Notes |
|---|---|---|
| Employee clock-in | **Exists** | `POST /api/work/clock-in`, `work_events.CLOCK_IN` |
| Employee clock-out | **Exists** | `POST /api/work/clock-out`, `work_events.CLOCK_OUT` |
| Break start | **Exists** | `POST /api/work/start-break` / `/start-lunch`, `is_break` on `work_registrations` |
| Break end | **Exists** | `POST /api/work/resume` |
| Activity start/end | **Exists** | `POST /api/work/start-activity`, `START_ACTIVITY` events; ending is implicit (next event closes the open registration) |
| Greenhouse location selection | **Exists** | Flat `locations`/`location_groups` model (post-refactor), `SCAN_LOCATION`/`CHANGE_LOCATION` event types |
| Row selection | **Exists** | Rows are `locations` rows linked via `greenhouse_rows.location_id`; selection goes through the same location endpoints |
| Team/crew assignment | **Exists** | `teams` table, `employment_records.team_id` |
| Supervisor corrections | **Partial** | `SUPERVISOR_CORRECT` event type + payload shape defined in the schema; **no HTTP route creates one yet** |
| Duplicate/overlapping time records | **Partial** | `wr_one_active` partial unique index prevents two *simultaneously open* registrations per employee; no explicit validation for overlapping backdated/corrected entries |
| Records spanning midnight | **Missing/unverified** | `employee_day_sessions` is keyed on `(employee_id, work_date)`; how a shift that crosses midnight is attributed isn't evident from the schema alone — needs explicit design before Android ships |
| Device identification | **Exists (unused)** | `devices`, `device_assignments`, `device_login_history` tables exist; no current route reads/writes them |
| Offline synchronization IDs | **Exists (schema only)** | `sync_batches`, `work_events.sync_batch_id`/`sequence_num`; no ingestion endpoint yet |
| Audit history (who changed what, when) | **Exists by design** | Event-sourced model (ADR-002/ADR-003 in `ARCHITECTURE_DECISIONS.md`) — `work_events` *is* the append-only audit log, with `actor_id`, `is_system`, `recorded_at` vs. `occurred_at` |

### Recommended build order

1. **Midnight-spanning session semantics + supervisor-correction HTTP
   routes** — both operate on the existing schema, no migration needed, and
   are prerequisites for trusting the data the Android app will eventually
   write.
2. **Offline sync ingestion endpoint** — batch-accept `work_events` keyed by
   client UUID + `sequence_num`, using the existing `sync_batches` table,
   with server-side duplicate detection on retry.
3. **Android app, online-only first** — login, clock in/out, activity/break
   changes, location/row selection, against `/api/v1`, with the connectivity
   check and offline/unavailable UI state from Section 6 — before adding the
   offline queue itself.
4. **Offline queue** — once the online path is proven, add the local queue
   and wire it to the sync endpoint from step 2.
5. **PIN/kiosk login** (Section 2) — if/when a shared-device workflow is
   needed, rather than one login per employee's own phone.
