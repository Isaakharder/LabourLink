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

`create-admin` is a one-time bootstrap — it exists only because the Employees
CRUD page (Phase 2) doesn't exist yet, so there'd otherwise be no way to log in.
Once Phase 2 ships, create employees through the UI instead.

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
- [ ] **Phase 2** — Employees page: create / edit / delete / activate-deactivate
      (still a placeholder; employees today are only created via `create-admin`
      or the DB directly)
- [x] **Phase 3** — Device pairing: pair, approve, name, assign employee
- [x] **Phase 4** — Setup page: pending-request list, device list, deactivate.
      Reassigning an already-paired device (re-approving a new pairing request
      for it) is supported; there is no separate "unpair" action distinct from
      deactivate
- [x] **Phase 5** — Mobile shell: home screen (start work / change activity /
      break / end day), sync status, nav. Mobile Settings screen is still a
      PIN-gate placeholder — no real settings behind it yet

Basic time tracking now exists, scoped tightly to what field testing needs:
an `activities` table seeded with the two current core activities (Winding &
Pruning, Picking Peppers) and a `time_entries` table recording work/break
spans per employee, enforced server-side to allow at most one open entry per
employee at a time and idempotent under duplicate/retried requests. Payroll,
row tracking, greenhouse logic, full offline background sync, and reporting
remain out of scope until explicitly scoped — see the project brief.

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
