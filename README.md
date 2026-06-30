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

## Production

Everything runs in Docker:

```bash
npm run start-prod
```

Builds and starts PostgreSQL, API, and web. No local Node.js required.

---

## Service URLs

| Service      | URL                          |
|--------------|------------------------------|
| Web          | http://localhost:3000        |
| API          | http://localhost:4000        |
| API health   | http://localhost:4000/health |
| PostgreSQL   | localhost:5432               |

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
├── server/                   Express API (TypeScript)
│   ├── src/
│   ├── nodemon.json          watches src/ for .ts changes, runs ts-node
│   ├── .env                  local dev DB connection (gitignored)
│   └── .env.example          template — copy to .env on first setup
├── web/                      React frontend (Vite + TypeScript)
│   ├── src/
│   ├── .env                  local dev API URL (gitignored)
│   └── .env.example          template — copy to .env on first setup
├── database/
│   └── migrations/           SQL migrations, run automatically on fresh DB
├── docs/                     Architecture decisions and module schemas
├── docker-compose.yml        defines postgres, api, web services
└── package.json              root scripts (db, dev, start-dev, start-prod)
```

---

## Documentation

Architecture decisions and module schema designs live in [docs/](docs/).
