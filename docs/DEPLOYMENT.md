# Local-Network Production Deployment

LabourLink runs on one dedicated Windows computer in the greenhouse, inside
Docker, reachable from other devices (including Android phones) on the same
Wi-Fi/local network. There is no internet exposure and no cloud dependency —
see `docs/ARCHITECTURE_DECISIONS.md` (ADR-001) for the reasoning.

This document covers the production Docker stack, host machine setup, and
operational procedures. For day-to-day **development**, see the root
[README.md](../README.md) — development is unaffected by anything here.

---

## 1. Docker structure

Two independent Compose files exist:

| File | Purpose |
|---|---|
| `docker-compose.yml` | Development — Vite HMR, nodemon, full source bind-mounted in. Unchanged by this deployment work. |
| `docker-compose.prod.yml` | Production — compiled API, production React build, nginx. **Use this on the greenhouse computer.** |

The production stack has three containers on one internal Docker network:

- **postgres** — PostgreSQL 16, data in the named volume `labourlink_postgres_data_prod`. No port published to the host.
- **api** — the compiled Express API (`node dist/server/src/index.js`, no ts-node/nodemon). No port published to the host.
- **web** — nginx serving the production React build and reverse-proxying `/api/*` and `/health` to the `api` container.

**`web` is the only container that publishes a port.** Postgres and the API
are reachable only from other containers on the internal Docker network —
never directly from the LAN. This satisfies "keep the database and API
internal" without the frontend or a future Android app ever needing to know
the API container's address: the built frontend calls relative `/api/...`
paths, which nginx forwards internally.

### Host port

Default: **8080**. LAN URL format:

```
http://<HOST_COMPUTER_IP>:8080
```

Port 80 is the more natural "no port number" URL, but Windows machines
commonly have something already bound to 80 (IIS, other local services,
`http.sys` reservations), and Docker Desktop sometimes needs elevated
permissions to publish it. 8080 is a safe default that works everywhere. To
switch to 80:

1. Confirm nothing is already using it:
   ```powershell
   netstat -ano | findstr :80
   ```
   If this returns no rows, port 80 is free.
2. Set `WEB_PORT=80` in `.env.production`.
3. Recreate the stack: `docker compose -f docker-compose.prod.yml --env-file .env.production up -d`.
4. The LAN URL becomes `http://<HOST_COMPUTER_IP>` (no port needed).

---

## 2. First-time setup on the greenhouse computer

```powershell
# 1. Clone the repository (or copy it) onto the greenhouse computer
git clone <repo-url> C:\LabourLink
cd C:\LabourLink

# 2. Create the production environment file
copy .env.production.example .env.production
notepad .env.production
```

In `.env.production`, set:

- **`SESSION_SECRET`** — a long random string. Generate one with:
  ```powershell
  [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
  ```
- **`POSTGRES_PASSWORD`** — a strong password (this is only applied the
  first time the database volume is created).
- **`WEB_PORT`** — `8080` (default) or `80` (see above).
- **`BACKUP_DIR`** — where backups are written, default `C:/LabourLinkBackups`
  (forward slashes, even on Windows — Docker Desktop translates the path).
- Leave `COOKIE_SECURE=false` — see [Section 5](#5-security-on-the-local-network).

```powershell
# 3. Build and start the production stack
npm run start-prod
# (equivalent to: docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build)

# 4. Check container status
docker compose -f docker-compose.prod.yml ps

# 5. Create the first administrator
docker compose -f docker-compose.prod.yml exec api npm run create-admin:prod
```

Alternatively, the first admin can be created through the browser: visit
`http://localhost:8080` (or the LAN IP) — if no users exist yet, the app
shows a one-time setup screen (`POST /api/setup/bootstrap-admin`), which
permanently disables itself once any user exists. The CLI command above is
for creating **additional** companies/admins afterward.

---

## 3. Host computer configuration (Windows)

### Find the computer's IPv4 address

```powershell
ipconfig
```

Look for the `IPv4 Address` under the active adapter (Wi-Fi or Ethernet) —
e.g. `192.168.1.42`. This is the address Android phones and other computers
on the same network will use.

### Reserve a static local IP

The greenhouse computer's IP must not change, or every device's saved server
address breaks. Two options, in order of preference:

1. **Router DHCP reservation (recommended)** — log into the Wi-Fi
   router/access point admin page, find the greenhouse computer's device
   (by its MAC address, shown via `ipconfig /all`), and reserve its current
   IP permanently. This keeps the OS-level network config untouched (still
   DHCP) while guaranteeing the same address every time.
2. **Static IP on the Windows adapter** — only if you don't have router
   access. `Settings → Network & Internet → [adapter] → IP assignment → Edit → Manual`,
   set IPv4 with an address outside the router's DHCP pool range, matching
   subnet mask and gateway.

### Allow the web port through Windows Defender Firewall

Only the chosen web port needs to be reachable, and only from the private
network profile — not "Any" network, not a broad allow rule:

```powershell
New-NetFirewallRule -DisplayName "LabourLink Web (8080)" `
    -Direction Inbound -Protocol TCP -LocalPort 8080 `
    -Action Allow -Profile Private
```

(Replace `8080` with `80` if you switched ports.) This does **not** expose
Postgres (5432) or the API (4000) — those ports are never published to the
host at all in the production stack, so there is nothing to firewall for
them.

### Verify access from another device

From another computer on the same network:

```powershell
Invoke-WebRequest http://192.168.1.42:8080/health
```

From an Android phone's browser (connected to the same Wi-Fi):

```
http://192.168.1.42:8080/health
```

Both should return `{"status":"ok","application":"LabourLink"}`. If this
fails, see [Troubleshooting](#troubleshooting) below.

### Start Docker Desktop automatically on boot

`Docker Desktop → Settings → General → "Start Docker Desktop when you sign in"`.
Also ensure the greenhouse computer is configured to **auto-login** (or that
Docker Desktop is set to start without requiring an interactive session), or
containers won't come back after an unattended reboot.

### Container restart policy

Already handled — every service in `docker-compose.prod.yml` has
`restart: unless-stopped`. If a container crashes, or the computer reboots
and Docker Desktop starts, containers come back automatically without manual
intervention.

### Verify containers after a reboot

```powershell
docker compose -f docker-compose.prod.yml ps
```

All three services should show `running (healthy)`. If any show `restarting`
or are missing, check logs: `docker compose -f docker-compose.prod.yml logs <service>`.

### Prevent Windows sleep/hibernation from stopping the server

A sleeping computer stops all containers. Disable sleep while on AC power
(leave battery/laptop-lid behavior alone if this is a desktop on permanent
power — these settings only affect the "Plugged in" profile):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 0   # optional — screen can still sleep, doesn't affect Docker
```

---

## 4. Security on the local network

Even though this deployment never leaves the local network, full
authentication and authorization stay enforced — nothing here trusts a
request just because it came from a LAN IP.

| Control | How it's enforced |
|---|---|
| No unauthenticated operational routes | `requireAuth` on every route except `/health`, `/api/setup/*` (self-disabling after first user), and login |
| Company scoping | Every route resolves `req.user.companyId` server-side from the session; per-handler `*BelongsToCompany` checks in `server/src/lib/companyScope.ts` |
| Permission checks | `requirePermission(code)` middleware against `role_permissions` |
| Session secret | `SESSION_SECRET` in `.env.production` — must be long and random (see Section 2) |
| Secrets outside Git | `.env.production` is git-ignored; only `.env.production.example` (placeholders) is tracked |
| Postgres exposure | No port published in `docker-compose.prod.yml` — reachable only from other containers |
| Dev ports exposure | Production stack has none: no Vite (3000), no ts-node/nodemon, no 4000 or 5432 published |
| Login rate limiting | IP-based (`express-rate-limit`, 20 attempts/15 min) layered on top of the existing per-account lockout (5 failed attempts/15 min, `server/src/routes/auth.ts`) |
| Request size limits | `express.json({ limit: '1mb' })` |
| Security headers | `helmet` (HSTS disabled — see below; CSP disabled since the API is JSON-only, not HTML) |
| Consistent JSON errors | Global 404 and error-handling middleware — the API never falls through to Express's default HTML error/404 pages |

### Cookie settings: local HTTP vs. future HTTPS

The session cookie's `Secure` flag is controlled by **`COOKIE_SECURE`**, a
dedicated environment variable — deliberately **not** tied to `NODE_ENV`.

- **Local HTTP deployment (this setup): `COOKIE_SECURE=false`.** A `Secure`
  cookie is only ever sent by the browser over HTTPS; setting it `true` on a
  plain-HTTP LAN deployment would make the browser silently drop the login
  cookie, breaking authentication with no visible error. `sameSite: 'lax'`
  and `httpOnly: true` still apply.
- **Future HTTPS deployment**: if a reverse proxy is later added in front of
  this stack terminating real TLS, set `COOKIE_SECURE=true` in
  `.env.production`. `app.set('trust proxy', 1)` is already enabled whenever
  `NODE_ENV=production`, so `req.protocol` and `X-Forwarded-*` handling are
  ready for that — no other code change needed.

### ⚠️ Plain HTTP on the local network — read before going live with real employee data

This deployment runs over **plain HTTP, with no transport encryption**. That
is a deliberate, scoped trade-off for a controlled, isolated greenhouse
Wi-Fi network — but it has real consequences that must be understood, not
just accepted implicitly:

- **Nothing on the wire is encrypted.** The browser session cookie and the
  Android `Authorization: Bearer <token>` header (see
  `docs/ANDROID_AND_TIMETRACKING.md` Section 2) both travel across the LAN
  in cleartext. Anyone who can observe traffic on that network segment — a
  compromised device on the same Wi-Fi, a rogue access point, ARP spoofing
  on an unmanaged switch — can capture a valid session credential and reuse
  it for as long as it remains unexpired and unrevoked. `httpOnly`,
  `sameSite`, and the hashed mobile-token storage described above all
  protect *at rest* and against several classes of client-side attack
  (XSS, CSRF, DB-leak replay) — none of them protect the credential *in
  transit* on plain HTTP.
- **This is acceptable only for a genuinely trusted, isolated network**: a
  single greenhouse's own Wi-Fi, not shared with guests, not bridged to a
  public network, with a firewall exposing only the one web port (Section
  3). It is a reasonable posture for **initial controlled testing** and for
  a small, physically-controlled site where the alternative (no
  digitization at all, or a much more complex rollout blocked on TLS
  tooling) is worse in practice.
- **It is not the right end state for real employee credentials on an
  ongoing basis.** The preferred final deployment is **local HTTPS** — see
  the implementation plan immediately below. This document intentionally
  does **not** implement HTTPS now (per the scope of this change); treat
  the plan as the next piece of work once the plain-HTTP deployment has
  been validated operationally.
- **Android specifically**: modern Android (API 28+) blocks cleartext
  (`http://`) traffic by default. Reaching this deployment from the Android
  app requires an explicit
  [`network_security_config.xml`](https://developer.android.com/privacy-and-security/security-config)
  permitting cleartext to the specific configured server address. This is a
  visible, deliberate opt-out that should be treated as **temporary** and
  called out in the app's own documentation/build config — not left as the
  permanent security posture, and not widened beyond the specific
  domain/IP the app is configured to talk to.

### Recommended local-HTTPS implementation plan (not implemented in this change)

Any of these terminate TLS at nginx (the only container with a published
port), so `api` and `postgres` stay exactly as internal as they are today —
only the `web` service's `nginx.conf` and the published port change.

1. **Locally-trusted certificate via `mkcert` (recommended starting point).**
   Generate a certificate for the greenhouse computer's LAN IP (and/or a
   chosen internal hostname) with [`mkcert`](https://github.com/FiloSottile/mkcert),
   mount it into the `web` container, and add a `listen 443 ssl;` server
   block to `nginx.conf` (keeping `listen 80` as a redirect to 443, or
   closing it). Install `mkcert`'s root CA on the greenhouse computer and on
   each Android device (`Settings → Security → Install a certificate`) —
   once trusted, the browser and the Android app both get a real padlock
   with no per-request cleartext opt-out needed. Downside: the CA must be
   manually installed on every device that connects, including any new
   phone.
2. **Internal hostname + internal CA (`step-ca` or similar), scales better
   for more devices.** Reserve an internal hostname (e.g. `labourlink.greenhouse.local`,
   resolved via the router's local DNS or a hosts-file entry on each
   device), run a small internal CA once, issue/renew a certificate for
   that hostname, and distribute the CA's public certificate to devices the
   same way as option 1. More setup up front, less per-device fuss if the
   device count grows.
3. **Self-signed certificate + Android network-security-config certificate
   pinning**, if avoiding any CA-installation step on the Windows machine is
   a hard requirement — nginx serves a self-signed cert, and the Android
   app's `network_security_config.xml` pins that specific certificate
   (rather than trusting it via cleartext exception). The browser will show
   a certificate warning on first connect that must be manually accepted
   per device; less clean for the web app than options 1–2, but avoids
   needing `mkcert`/an internal CA at all.

In all three, once HTTPS is live: set `COOKIE_SECURE=true`, keep
`sameSite: 'lax'` (or reassess if the deployment topology changes), and
update the Android app's base URL to `https://`. No server-side session or
mobile-token logic changes — the credential mechanisms described above are
already transport-agnostic; only the transport itself needs to change.

---

## 5. Database durability and backups

The named volume `labourlink_postgres_data_prod` is the single source of
truth. It survives:

- Rebuilding images (`docker compose ... up -d --build`)
- Recreating containers (`docker compose ... up -d`, `docker compose ... restart`)
- `docker compose -f docker-compose.prod.yml down` (without `-v`)
- A full Windows computer restart (as long as Docker Desktop is set to
  auto-start — see Section 3)

> **`docker compose down -v` deletes the database volume.** Never run this
> against the production stack unless you have an explicit reason and a
> recent backup. None of the scripts or commands in this document use `-v`.

### Backup

```powershell
.\scripts\backup-db.ps1
```

Writes a timestamped `pg_dump` (custom format) to `C:\LabourLinkBackups`
(configurable via `-BackupDir` or the `LABOURLINK_BACKUP_DIR` environment
variable). Runs `pg_dump` inside the postgres container, writing directly to
the bind-mounted host folder — no PowerShell redirection of binary output.

### List backups

```powershell
.\scripts\list-backups.ps1
```

### Restore

```powershell
.\scripts\restore-db.ps1 -BackupFile "C:\LabourLinkBackups\labourlink_20260710_120000.dump"
```

**Destructive** — replaces all current data. Requires typing `YES` to
confirm. Restarts are not automatic; restart the API afterward if it was
running: `docker compose -f docker-compose.prod.yml restart api`.

### Updating from GitHub

```powershell
.\scripts\update-app.ps1
```

Backs up the database, pulls the latest commit on `master`, rebuilds and
restarts the stack, and prints the previous commit SHA.

### Rolling back a failed update

```powershell
.\scripts\rollback.ps1 -CommitOrTag <sha-printed-by-update-app>
```

Checks out the previous commit and rebuilds. Does **not** automatically
restore the database (a schema rollback isn't always safe) — use
`restore-db.ps1` with the backup `update-app.ps1` made if the database also
needs to go back.

---

## Troubleshooting

**Can't reach `http://<IP>:8080` from another device:**
1. Confirm the container is actually listening: `docker compose -f docker-compose.prod.yml ps` should show `web` as `running (healthy)`.
2. Confirm the firewall rule exists and targets the right port/profile: `Get-NetFirewallRule -DisplayName "LabourLink Web*"`.
3. Confirm both devices are on the same network (not a guest/isolated Wi-Fi SSID — many routers isolate guest networks from each other by design).
4. Re-verify the IP with `ipconfig` — it may have changed if a static reservation wasn't set up (see Section 3).
5. Try from the host machine itself first: `Invoke-WebRequest http://localhost:8080/health` — if this fails too, the problem is the containers, not the network.

**Login works locally but not from another device:** almost always a stale
saved IP on the client, or the firewall rule scoped to the wrong profile
(must be `Private`, not `Public`/`Domain` if the network is categorized
differently than expected — check with `Get-NetConnectionProfile`).

**Containers don't come back after a reboot:** confirm Docker Desktop is set
to start on sign-in (Section 3) and that the computer isn't sitting at a
lock screen requiring manual login before Docker Desktop can start.
