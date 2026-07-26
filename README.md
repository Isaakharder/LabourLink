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
2. Once it's provisioned, go to **Project Settings → Database → Connection string → URI**.
   Copy that value — you'll need it for `DATABASE_URL`.

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

1. Create a new Railway project, then add **two services** from the same GitHub repo:
   - **api** service → set its root directory to `server/`
   - **web** service → set its root directory to `web/`
2. On the **api** service, set environment variables: `DATABASE_URL` (Supabase URI),
   `JWT_SECRET`, `CORS_ORIGIN` (the web service's public URL), `PORT` is set by Railway automatically.
3. On the **web** service, set `VITE_API_URL` to the api service's public URL, and set the
   build command to `npm run build` with start command `npm run preview -- --host 0.0.0.0 --port $PORT`
   (or serve `dist/` with a tiny static server — fine to revisit once Phase 1 is stable).
4. Run `npm run migrate` and `npm run create-admin` once against the production
   `DATABASE_URL` (locally, pointed at prod, is simplest) before first login.

## Milestones

- [x] **Phase 1** — Railway project, Supabase project, database schema, authentication,
      desktop layout, mobile layout
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
