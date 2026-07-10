# LabourLink

Local-first greenhouse labour management system.

## Stack

| Layer    | Technology                                          |
|----------|-----------------------------------------------------|
| Frontend | React + TypeScript + Vite + Tailwind + shadcn/ui    |
| Backend  | Node.js + Express + TypeScript                      |
| Database | PostgreSQL 16                                       |
| Deploy   | Docker Compose                                      |

---

## Development

In development, PostgreSQL runs in Docker and the API and web run locally
with hot reload. File saves restart the API and update the browser instantly.

### Prerequisites

- Node.js 20+
- Docker Desktop (must be running)
- npm 9+

### First-time setup

```bash
# 1. Install root dependencies
npm install

# 2. Install API dependencies
npm install --prefix server

# 3. Install web dependencies
npm install --prefix web

# 4. Create environment files
#    macOS / Linux:
cp server/.env.example server/.env
cp web/.env.example web/.env
#    Windows:
copy server\.env.example server\.env
copy web\.env.example web\.env
```

### Start development

```bash
npm run start-dev
```

This starts PostgreSQL in Docker, then launches the API (port 4000) and
Vite (port 3000) locally side by side with hot reload.

Or step by step:
```bash
npm run db    # start PostgreSQL in Docker
npm run dev   # start API + web locally (run in same terminal)
```

Press `Ctrl+C` to stop the API and web. PostgreSQL stays running.

---

## Scripts

| Script              | What it does                                            |
|---------------------|---------------------------------------------------------|
| `npm run db`        | Start PostgreSQL in Docker                              |
| `npm run dev`       | Start API + web locally with hot reload                 |
| `npm run start-dev` | Start PostgreSQL and dev servers in one command         |
| `npm run start-prod`| Build and start all three services in Docker            |

---

## Production (local-network deployment)

Full walkthrough, host machine setup, security notes, and Android
integration details: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** and
**[docs/ANDROID_AND_TIMETRACKING.md](docs/ANDROID_AND_TIMETRACKING.md)**.

Production uses a **separate** Compose file (`docker-compose.prod.yml`) with
compiled builds, no Vite/nodemon, and nginx serving the frontend + proxying
`/api` — it does not touch the dev stack or its data.

```powershell
# First time only
copy .env.production.example .env.production
notepad .env.production   # set SESSION_SECRET and POSTGRES_PASSWORD

# Start local-network production mode
npm run start-prod
```

### Exact PowerShell commands

| Task | Command |
|---|---|
| Start dev mode | `npm run start-dev` |
| Start local-network production mode | `npm run start-prod` |
| Stop production without deleting data | `npm run stop-prod` (never add `-v`) |
| Check container status | `docker compose -f docker-compose.prod.yml ps` |
| View logs | `npm run logs-prod` |
| Find the host's LAN IP | `ipconfig` (look for `IPv4 Address`) |
| Test from another device | `Invoke-WebRequest http://<HOST_IP>:8080/health` |
| Update from GitHub | `.\scripts\update-app.ps1` |
| Run migrations manually | `docker compose -f docker-compose.prod.yml exec api npm run migrate:prod` |
| Back up PostgreSQL | `.\scripts\backup-db.ps1` |
| List backups | `.\scripts\list-backups.ps1` |
| Restore PostgreSQL | `.\scripts\restore-db.ps1 -BackupFile <path>` |
| Reboot recovery check | `docker compose -f docker-compose.prod.yml ps` (after Docker Desktop starts) |
| Create the first administrator | `docker compose -f docker-compose.prod.yml exec api npm run create-admin:prod` (or use the in-app setup screen on first visit) |
| Change the session secret | Edit `SESSION_SECRET` in `.env.production`, then `npm run start-prod` again (this invalidates all existing sessions — everyone is logged out) |
| Roll back a failed update | `.\scripts\rollback.ps1 -CommitOrTag <sha>` |

Firewall/local-network troubleshooting: see the
[Troubleshooting section of docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#troubleshooting).

---

## Service URLs

### Development

| Service      | URL                          |
|--------------|------------------------------|
| Web          | http://localhost:3000        |
| API          | http://localhost:4000        |
| API health   | http://localhost:4000/health |
| PostgreSQL   | localhost:5432               |

### Production (local network)

| Service      | URL                                    |
|--------------|-----------------------------------------|
| Web + API    | http://\<HOST_IP\>:8080 (single port)   |
| API health   | http://\<HOST_IP\>:8080/health          |
| PostgreSQL   | not exposed — internal to Docker only   |

In production, nginx is the only published port. It serves the built
frontend and proxies `/api/*` and `/health` to the API container internally
— neither the browser nor a future Android app ever talks to the API or
Postgres containers directly.

---

## Day-to-Day Workflow

### Starting a session

```bash
npm run start-dev
```

If PostgreSQL is already running from a previous session:

```bash
npm run dev
```

### Stopping

`Ctrl+C` stops the API and web. PostgreSQL keeps running between sessions.

To stop everything including PostgreSQL:

```bash
docker compose down
```

### Switching from production Docker to local dev

If you last ran `npm run start-prod`, the API and web are running in Docker
on ports 4000 and 3000. Stop them before starting local dev to avoid port
conflicts:

```bash
docker compose stop api web
npm run dev
```

PostgreSQL can stay running — no restart needed.

### Resetting the database

```bash
docker compose down -v    # removes containers and the data volume
npm run db                # starts a fresh PostgreSQL and re-runs migrations
```

### Connecting to the database directly

```bash
docker exec -it labourlink_postgres psql -U labourlink -d labourlink
```

---

## Project Layout

```
LabourLink/
├── server/                    Express API (TypeScript)
│   ├── src/
│   ├── Dockerfile             multi-stage: dev (nodemon) / prod (compiled)
│   ├── nodemon.json           watches src/ for .ts changes, runs ts-node
│   ├── .env                   local dev DB connection (gitignored)
│   └── .env.example           template — copy to .env on first setup
├── web/                       React frontend (Vite + TypeScript)
│   ├── src/
│   ├── Dockerfile             multi-stage: dev (Vite) / prod (nginx)
│   ├── nginx.conf             production static serving + /api reverse proxy
│   ├── .env                   local dev API URL (gitignored)
│   └── .env.example           template — copy to .env on first setup
├── database/
│   └── migrations/            SQL migrations, run automatically on fresh DB
├── scripts/                   PowerShell ops scripts (backup, restore, update, rollback)
├── docs/                      Architecture decisions, deployment guide, Android/time-tracking notes
├── docker-compose.yml         dev stack: postgres, api, web (hot reload)
├── docker-compose.prod.yml    production stack: postgres, api, web (compiled + nginx)
├── .env.production.example    template — copy to .env.production for production
└── package.json                root scripts (db, dev, start-dev, start-prod, stop-prod, logs-prod)
```

---

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — production Docker structure, host machine setup, security, backups
- [docs/ANDROID_AND_TIMETRACKING.md](docs/ANDROID_AND_TIMETRACKING.md) — Android API prep and time-tracking readiness audit
- [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md) — ADRs
- Module schema designs live in the rest of [docs/](docs/)
