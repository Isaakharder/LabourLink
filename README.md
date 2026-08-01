# LabourLink V2

Clean rebuild. Two interfaces — a desktop app (sidebar nav: Dashboard, Inputs,
Employees, Devices, Setup, Settings) and a mobile PWA for paired field
devices — sharing one Postgres database (Supabase) and one Express API
(Railway).

Built incrementally, one fully-working phase at a time. See "Milestones" below
for what's real right now vs. what's a placeholder waiting on a later phase.

## Stack

- **Frontend:** React + TypeScript (Vite), plain CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** Supabase (Postgres) — accessed via `pg`, not the Supabase client SDK,
  so all auth/role logic lives in our own Express layer
- **Hosting:** Railway (Nixpacks, no Docker)

## Repo layout

```
server/   Express API + SQL migrations
web/      React app (desktop layout + mobile PWA shell, same codebase)
```

## Local setup

### 1. Create the Supabase project

1. Go to https://supabase.com/dashboard and create a new project.
2. Once it's provisioned, go to **Project Settings → Database → Connect** and copy the
   **Session pooler** connection string (not "Transaction pooler" — that mode doesn't
   support the long-lived, persistent connections `pg.Pool` keeps open, which is what
   our always-on Express server uses). That string is your `DATABASE_URL`.
3. The project's `anon`/`publishable` key and REST URL (shown on the same page) are **not
   used** by this app — the backend talks to Postgres directly via `pg`, not the Supabase
   client SDK or its REST/PostgREST layer. Nothing Supabase-specific ever reaches the
   frontend, so there's no key to expose there.

### 2. Configure and run the server

```
cd server
cp .env.example .env
# edit .env: paste your Supabase DATABASE_URL, set a random JWT_SECRET
npm install
npm run migrate        # applies server/migrations/*.sql
npm run create-admin -- "Jane" "Doe" jane@example.com 123456
npm run dev             # http://localhost:4000
```

`create-admin` is a one-time bootstrap for the *first* administrator — the
Employees page (see "Employee management" below) never sets a PIN, so it
can't grant desktop login on its own. Employees created through the UI can
still be assigned mobile devices immediately; `create-admin` (or direct DB
access) is the only way today to give someone a PIN and desktop access.

Employee profile photos also need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` set in `server/.env` — see "Employee management"
below.

### 3. Configure and run the web app

```
cd web
cp .env.example .env
npm install
```

### 4. Run both together

From the repo root (after both `.env` files above are set up):

```
npm install                # installs concurrently, the root dev dependency
npm run dev                 # starts server (:4000) and web (:5173) together
```

Or `npm run dev:server` / `npm run dev:web` from the root to run just one, or
`cd server && npm run dev` / `cd web && npm run dev` as before. `npm run
install:all` from the root installs all three `node_modules` (root, server,
web) in one go.

- **Desktop:** http://localhost:5173/ (any normal-width browser window)
- **Mobile:** http://localhost:5173/mobile — or shrink the window below
  ~768px / use dev tools device emulation on the desktop URL; the app picks a
  layout based on viewport width, not the URL prefix

## Employee management

The desktop Employees page (`/employees`, Administrator/Manager to view,
Administrator to add/edit) manages the `employees` table directly — there's
no separate "users" system.

**Required fields:** first name, last name, start date, nationality
(Canadian or Mexican — constrained at the DB level via a `CHECK` constraint).
**Optional:** profile photo, email, phone number, date of birth, gender
(Male / Female / Prefer not to say), job group, employee number, preferred
language (English / Spanish), notes. Email and employee number are unique
when supplied (email case/whitespace-insensitively, matching login's
normalization) but neither is required — field employees who never get
desktop access don't need either. Phone numbers are normalized to
`+<countrycode><digits>`, using the nationality field to pick `+1` vs `+52`
for a bare 10-digit number. New employees default to the `Employee` security
role and `Team Member` team role unless the admin picks something else, and
default to Active.

**Mobile-only vs. desktop-login employees:** `settings_pin_hash` is
nullable. The Employees page never sets a PIN — every employee it creates
can be assigned a mobile device (device-identifier auth, see "Testing from a
real phone" below) but cannot log into the desktop app until a PIN exists.
The only way to set one today is `npm run create-admin` (bootstraps an
Administrator with a PIN) or direct DB access; there's no in-app "grant
desktop access" action yet. Deactivating an employee (`isActive: false`)
immediately ends any active device assignment they have (device stays
paired, free for reassignment) and is blocked from mobile auth on their very
next request regardless — nothing is deleted, so their historical time
entries and the (now-ended) assignment record both remain queryable.

**Profile photos** go through Supabase Storage, never through Postgres or
the browser directly:
- Bucket `employee-profile-photos` (override with `SUPABASE_STORAGE_BUCKET`
  in `server/.env`), created automatically on first upload if it doesn't
  exist — private, 5MB limit, JPEG/PNG/WebP only (enforced both by the
  bucket config and server-side by `multer`+`sharp` before upload).
- Every upload is re-encoded server-side to a centered-crop 512×512 WebP
  regardless of the source image's shape or format, at a unique path
  (`employees/{employeeId}/{uuid}.webp`) — `employees.profile_photo_path`
  stores only that path, never a URL or the image itself.
- The API only ever returns short-lived signed URLs (`getSignedPhotoUrl`
  in `server/src/lib/storage.ts`, 1 hour by default) — nothing in the bucket
  is publicly reachable.
- Replacing a photo uploads the new one, updates the DB row, *then* deletes
  the old storage object — never the other way around, so a mid-request
  failure can't leave the employee with no photo at all.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (`server/.env`) are
  required for any of this to work — the service-role key is server-only,
  read via `process.env` in `server/src/lib/storage.ts`, and is never sent
  to or reachable from the browser bundle (nothing in `web/` imports that
  module, and Vite only ever inlines `VITE_`-prefixed variables into the
  client build regardless).

## Testing from a real phone on the same Wi-Fi

The dev server binds all network interfaces (`server: { host: true }` in
`web/vite.config.ts`), not just localhost, so a phone on the same Wi-Fi
network as the dev machine can reach it — `npm run dev` prints the LAN
address Vite is listening on (look for the `Network:` line).

**One-time setup per network** (your LAN IP changes between networks and
sometimes between DHCP renewals — check with `ipconfig` on Windows or
`ifconfig`/`ip addr` on macOS/Linux):

1. In `server/.env`, add the LAN origin to `CORS_ORIGIN` as a comma-separated
   list alongside localhost:
   ```
   CORS_ORIGIN=http://localhost:5173,http://<your-lan-ip>:5173
   ```
2. Leave `VITE_API_URL` **unset** in `web/.env` (comment it out or delete the
   line). With no `VITE_API_URL`, the frontend targets whatever host the page
   was loaded from (see `web/src/lib/api.ts`) — this is what makes the same
   build work correctly from both `localhost` and the phone's LAN address
   without editing anything per-device. Only set `VITE_API_URL` explicitly
   for production, where the frontend and API live on different domains.
3. Restart `npm run dev` after editing `.env` files.

**Pairing a phone:**

1. Confirm the phone is on the same Wi-Fi network as the dev machine.
2. On the phone's browser, go to `http://<your-lan-ip>:5173/mobile`.
3. It shows a 6-digit pairing code and "Waiting for approval."
4. On the desktop, log in and open **Setup**. The pending request appears
   there (polls every 5s, or refresh) showing the same code — match it
   against what the phone is showing, enter a device name, choose the
   employee to assign, click **Approve**.
5. The phone transitions to its Home screen within ~3s (its own poll
   interval) — no PIN or admin email is ever entered on the phone.
6. If the phone never sees the approval, or the pairing request never
   reaches the desktop, it's almost always `CORS_ORIGIN` not matching the
   phone's current LAN IP — recheck step 1 above.

Installable as a PWA from either OS: Android Chrome → "Add to Home Screen";
iOS Safari → Share → "Add to Home Screen" (manifest, service worker, and
icons are already in place).

## Deploying to Railway (no Docker)

Railway builds Node projects directly with Nixpacks, so no Dockerfile is needed.
`server/railway.json` and `web/railway.json` pin each service's build command, start
command, and health-check path so the dashboard settings are just a root directory and
environment variables.

1. Create a new Railway project from the `Isaakharder/LabourLink` GitHub repo, then add
   **two services** (Railway will ask which directory each uses — a monorepo needs one
   service per app):
   - service named **api** → root directory `server/`
   - service named **web** → root directory `web/`
2. **api** service environment variables:
   - `DATABASE_URL` — the Supabase Session pooler string from step 1 above
   - `JWT_SECRET` — a long random value (`openssl rand -hex 32`)
   - `CORS_ORIGIN` — `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` (Railway's cross-service
     variable reference — resolves to the web service's live URL automatically)
   - `NODE_ENV` — `production`
   - `PORT` — set automatically by Railway, no action needed
3. **web** service environment variables:
   - `VITE_API_URL` — `https://${{api.RAILWAY_PUBLIC_DOMAIN}}` (Vite inlines this at
     build time, so it must be set before the build runs, not just at runtime)
   - `PORT` — set automatically by Railway, no action needed
4. Generate a public domain for both services (Settings → Networking → Generate Domain).
5. Run `npm run migrate` and `npm run create-admin` once against the production
   `DATABASE_URL` (running them locally, pointed at prod via a temporary `server/.env`,
   is simplest) before the first login.

## Milestones

- [x] **Phase 1** — Railway project, Supabase project, database schema, authentication,
      desktop sidebar layout, mobile shell (PWA installable — icons, manifest, service worker)
- [x] **Phase 2** — Employees page: create / edit / activate-deactivate, profile
      photos (Supabase Storage). "Delete" is deliberately not offered — see
      Employee management above; soft deactivation only
- [x] **Phase 3** — Device pairing: pair, approve, name, assign employee
- [x] **Phase 4** — Setup page: pending-request list, device list, deactivate.
      Reassigning an already-paired device (re-approving a new pairing request
      for it) is supported; there is no separate "unpair" action distinct from
      deactivate
- [x] **Phase 5** — Mobile shell: home screen (start work / change activity /
      break / end day), sync status, nav. Mobile Settings screen is still a
      PIN-gate placeholder — no real settings behind it yet
- [x] **Phase 6** — Activities module: desktop Activities / Activity Groups
      pages (CRUD, deactivate not delete), employee-to-activity-group
      assignment (one active group per employee, reassignment closes the old
      assignment rather than deleting it), mobile activity picker fully
      server-driven and scoped to the employee's own assignment

Basic time tracking now exists, scoped tightly to what field testing needs:
an `activities` table (plus `activity_groups` and the join/assignment tables
that scope activities to employees) and a `time_entries` table recording
work/break spans per employee, enforced server-side to allow at most one open
entry per employee at a time and idempotent under duplicate/retried requests.
Payroll, row tracking, greenhouse logic, full offline background sync, and
reporting remain out of scope until explicitly scoped — see the project
brief.

**Mobile activity assignment**: an employee's phone only ever shows
activities that are active *and* belong to their currently assigned active
Activity Group (`GET /api/mobile/activities`) — never a hardcoded or
fallback list. An employee with no active group, or whose group currently
has no active activities, sees "No activities have been assigned to you.
Please contact your supervisor." instead of any activity list, and Start
Work / Change Activity are disabled until that's resolved. Every Start
Work/Change Activity request is revalidated server-side against the
employee's current group regardless of what the client sends, so an
activity that's been deactivated or removed from the group can never be
newly selected — including on offline-queue replay. An activity an
employee is *already* working on stays visible in their status and can
still be ended/broken out of cleanly even after it's deactivated or removed
from their group; it just won't be offered again as a new choice.

## Known gaps

- **Windows nodemon restart race**: editing server files while `npm run dev`
  is running can occasionally hit `EADDRINUSE` on Windows and nodemon gives
  up silently, leaving the *old* code still serving requests. If a server
  change doesn't seem to take effect, stop (`Ctrl+C`, then confirm the port
  is free) and restart cleanly rather than trusting the auto-reload.
- **Offline handling is intentionally minimal**: mobile actions that fail on
  a network error are queued in `localStorage` and retried when the browser
  fires an `online` event, using the same idempotency key so a retry can't
  double-record — this is not a full background-sync/IndexedDB system, and
  isn't meant to survive an extended fully-offline shift.
- A deactivated device's phone is correctly rejected and returned to the
  pairing screen, but there's no explicit "this device was removed" message
  — it just looks like a fresh pairing flow.
