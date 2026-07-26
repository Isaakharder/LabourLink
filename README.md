# LabourLink V2

Clean rebuild. Two interfaces — a 3-page desktop app (Inputs, Employees, Setup)
and a mobile PWA for paired devices — sharing one Postgres database (Supabase)
and one Express API (Railway).

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
npm run dev             # http://localhost:5173
```

Open http://localhost:5173 in a normal browser window for the desktop layout.
Shrink the window below ~768px wide (or open dev tools device emulation) to
see the mobile shell — the app picks a layout based on viewport width.

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

- [ ] **Phase 1** — Railway project, Supabase project, database schema, authentication,
      desktop layout, mobile layout (scaffolded; not yet verified live — see Known gaps)
- [ ] **Phase 2** — Employees page: create / edit / delete / activate-deactivate
- [ ] **Phase 3** — Device pairing: pair, approve, name, assign employee
- [ ] **Phase 4** — Setup page: device management, reassignment, disable, unpair
- [ ] **Phase 5** — Mobile shell: home screen, PIN-protected settings, sync button, nav

Do not start a phase until the previous one is fully working. No activities,
work sessions, payroll, row tracking, greenhouse logic, offline sync, or
background jobs until explicitly scoped — see the project brief.

## Known gaps to close before Phase 1 is "done"

- `web/public/manifest.json` references `icon-192.png` / `icon-512.png` that
  don't exist yet — add real app icons before treating the PWA as installable.
- Employees/Setup pages, and the mobile pairing/settings screens, are
  intentionally static placeholders — see the phase list above.
