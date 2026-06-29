# LabourLink

Local-first greenhouse labour management system.

## Stack

| Layer    | Technology                              |
| -------- | --------------------------------------- |
| Frontend | React · TypeScript · Vite · Tailwind    |
| Backend  | Node.js · Express · TypeScript          |
| Database | PostgreSQL                              |
| Deploy   | Docker Compose                          |

## Getting Started

```bash
# Start all services
docker-compose up -d

# Frontend  http://localhost:3000
# API       http://localhost:4000
# Postgres  localhost:5432
```

## Development (without Docker)

```bash
# Backend
cd server
npm install
npm run dev

# Frontend
cd web
npm install
npm run dev
```

## Project Layout

```
LabourLink/
├── server/       Express API
├── web/          React frontend
├── database/     Migrations and seeds
├── backups/      Database backups
└── docs/         Architecture and design docs
```

## Documentation

See [docs/](docs/) for architecture, navigation, and module documentation.
