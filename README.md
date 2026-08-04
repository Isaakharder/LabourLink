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

## Daily activity-log review & correction (Inputs page)

The desktop Inputs page (`/inputs`, Administrator/Manager/Supervisor —
Employee and Crew Leader get a clear "Insufficient permissions" message
rather than the data, matching how the Employees page already restricts
reads) is where a supervisor reviews and corrects one employee's activity
log for one calendar day.

**Layout:** a date selector (defaults to "today" in `APP_TIMEZONE`, with
prev/next arrows and a direct date picker) above a two-column layout — a
searchable, alphabetically-sorted employee list on the left (selection
persists across date changes and is stored in the URL as `?date=&employee=`
so a link can be shared/bookmarked), and the selected employee's day on the
right: an activity-logs card followed by a "Workday details" card.

**Activity runs, not raw rows:** consecutive `work` time entries for the
*same* activity, separated only by breaks, are merged into one row (its
duration excludes the break time) — the same job-chain contiguity concept
the mobile timer uses. If the employee later switches to a different
activity and then comes back to the first one, that's a **separate** row,
not merged with the earlier one. Columns: Activity, Normal Speed (the
activity's *configured* `normal_speed`/`speed_unit` — never a measured
value, see "Known gaps" below; shows "—" when no speed is configured),
Duration, End Time. The row for whichever activity is still in progress
shows a live-updating duration and its End Time is not editable.

**Correcting an end time:** click a closed row to select it, then click its
End Time cell to edit (native `<input type="time" step="1">`; Enter saves,
Escape cancels). Saving opens a reason modal — a reason of at least 3
characters is required, and the button stays disabled until one is entered.
On confirm, the server validates the new time doesn't move outside the
entry's own calendar day, isn't before the entry's start, and doesn't push
past the next entry's start time (landing exactly on that boundary is
allowed, since repairing a chain back into contiguity is the point).  Every
accepted correction is recorded in `time_entry_corrections` (old value, new
value, reason, who made the change, when) — nothing is overwritten
silently, and this is currently the only audited field in the app.

**Workday details card** shows the day's earliest work-entry start time and
each break's start time and duration.

### Known gaps

- **Speed is configured, not measured.** There's no output-quantity column
  anywhere in the schema (no kg/rows/plants/boxes completed), so an actual
  worked-speed figure cannot be calculated. The "Normal Speed" column is
  always the activity's configured baseline, labeled accordingly.
- **Breaks aren't classified paid/unpaid.** The Workday details card shows
  a single Duration column for each break instead of separate Paid/Unpaid
  columns, since that distinction isn't tracked in the data model yet.
- Editing a still-*open* (in-progress) entry's end time is out of scope —
  only already-closed entries can be corrected.

## Greenhouse Layout editor (Setup page)

The desktop Setup page (`/setup/layout`) includes a full-screen, CAD-style
editor for drawing a greenhouse property ("land") to scale in real feet and
positioning rectangular "phases" within it. Unlike the rest of the app, this
route takes over the entire viewport rather than sitting inside the normal
sidebar/padded-card frame.

**Full-screen mode:** entering the route hides the normal Setup page
header/tabs and the app goes full-bleed (no padding, no page scrollbar) for
as long as the editor is mounted — `document.body`'s scroll is locked too.
Leaving the route by any means (the editor's own **Back** button, a sidebar
nav click, or the browser Back button) always restores the normal page
chrome and body scrolling, since that state is owned by `AppLayout` (shared
via `useOutletContext`) rather than by the editor page itself, so it can
never strand another page in a hidden-chrome state.

**Sidebar collapse:** the toolbar's **Hide navigation** button collapses the
main sidebar to a small restore tab at the left edge, reclaiming its width
for the canvas; clicking the restore tab (or leaving the route) brings the
full sidebar back.

**Pan/zoom controls:** the canvas is a transform-based viewport (pan in
screen pixels, scale in pixels-per-foot) — phase/land geometry is always
kept in real feet.
- **Zoom:** mouse wheel, centered on the cursor (the land point under the
  pointer stays put), clamped to roughly 15%–600% of the "fit" scale. The
  toolbar's `+`/`-` buttons and `Fit to screen` do the same, recomputing
  against the current viewport size.
- **Pan:** middle-mouse drag, Spacebar+left-drag, or a plain left-drag
  starting on empty canvas (dragging a phase itself always moves the phase,
  never pans). Panning is clamped so the land can't be dragged entirely
  off-screen.
- Clicking empty canvas (without dragging) deselects the current phase.

**Keyboard shortcuts** (ignored while typing in a text field, but not
blocked by a focused checkbox/button):
- `+` / `-` — zoom in/out
- `0` — Fit to screen
- `Escape` — cancels an in-progress pan, or clears the current selection
- `Ctrl`/`Cmd`+`S` — saves the active edit (phase position or layout draft)

**Save/cancel behavior:** phase edits made in **Edit Phases** mode (drag,
snap-to-grid, prevent-overlap) are draft-only until **Save Layout** is
clicked (or `Ctrl`/`Cmd`+`S`) — **Cancel Changes** reverts to the last saved
positions. When "Prevent overlap" is on and the current draft has an
overlap, Save Layout is disabled until it's resolved or the toggle is
turned off. Editing the land's dimensions (**Edit Land**) refreshes the
canvas — dimensions, scale, and fit — immediately, without requiring a route
change or reselecting the land.

## Greenhouse row layouts (Add/Edit Rows)

Inside the Greenhouse Layout editor, selecting a phase shows four action
buttons: **Edit Phase**, **Edit Position**, **Add/Edit Rows**, **Deactivate**
— in that order, unchanged from before rows existed. **Add/Edit Rows** opens
a panel beneath those buttons (the phase stays selected and visible on the
canvas; its drag is disabled while this panel is open, so placing rows can
never accidentally move the phase) where a supervisor defines one *batch* of
rows at a time and saves it.

**Row coordinates are relative to their phase**, not the land — a row's
`x_ft`/`y_ft` are an offset from its own phase's north-west corner, the same
nesting pattern phases already use relative to their land
(`x_feet_from_west`/`y_feet_from_north`). The canvas renders a row at
`phase.xFeetFromWest + row.xFt`, `phase.yFeetFromNorth + row.yFt`, so:
- **Moving a phase moves its rows for free** — no row is ever rewritten when
  a phase is dragged or repositioned.
- **Resizing a phase smaller is blocked** (409) if any existing row would no
  longer fit inside the new dimensions — delete or adjust those rows first.
- **Resizing the *land*** already proportionally rescales every phase it
  contains (position and size); that same per-axis ratio is cascaded to
  every row in every affected phase in the same transaction, so rows never
  drift out of sync with a rescaled phase. The row *batch* (the recipe that
  created the rows — see below) is deliberately left as originally entered;
  only the persisted row geometry is rescaled.

**Start side and anchor side** together determine where a batch's rows go.
`startSide` (North/South/East/West) is the edge rows are stacked outward
from — row 1 sits nearest that edge, each following row number one step
further in. `anchorSide` is the edge each row's own length is flush against;
the row extends away from that edge for the chosen length. The two must be
perpendicular (South/North only ever pairs with East/West, and vice versa —
pairing a side with itself or its opposite has no defined meaning and is
rejected). The full mapping is documented as a table at the top of
`server/src/lib/rowLayout.ts` (mirrored for client-side preview at
`web/src/lib/rowLayout.ts`); for example, South start + East anchor stacks
rows inward from the south edge, each one flush against the east edge and
extending west.

**Numbering modes** — *All numbers*, *Odd only*, *Even only* — apply to the
inclusive start/end row-number range by filtering, not rounding: an odd-only
batch numbered 2–16 produces 3, 5, 7, …, 15 (the odd numbers actually inside
that range), never silently shifting the boundary itself.

**Row width, length, gap, and offset** are all in feet. Width is the row's
short dimension (perpendicular to its length); gap is empty space left
between consecutive rows in the same batch (0 means rows sit directly beside
each other, sharing an edge — that's "touching," not "overlapping," and is
allowed). Offset is a manual inset from the phase edge the batch starts
from, e.g. to leave a walkway.

**Continuation**: checking "Continue from the last row on this side" makes
a new batch start immediately after the furthest-stacked row that shares the
*same phase and start side* (any prior batch, not just the one before it),
plus that new batch's own gap. A manual offset combines additively on top of
that computed point, e.g. to leave extra breathing room before a follow-up
batch begins. A batch anchored from the *opposite* side (e.g. North instead
of South) with its own manual offset is how an intentional centre walkway
between two opposing batches is expressed — there's no separate walkway
object in this first version.

**Validation** happens both live in the browser (as fields change, before
saving) and independently on the server when the batch is actually
submitted — the server always recomputes every row's geometry itself from
the submitted batch parameters via the same `rowLayout.ts` placement
functions; it never trusts client-submitted row coordinates. A save is
rejected if any row would fall outside the phase, overlap another row
(within the new batch or against any existing active row in the phase,
regardless of which batch placed it), or reuse a row number already active
in that phase.

**Saved geometry is final, not regenerated.** `greenhouse_row_batches` is
only the creation recipe (side, anchor, numbering, gap, offset — useful for
display and for continuation math); `greenhouse_rows` holds each row's
actual persisted `x_ft`/`y_ft`/`width_ft`/`length_ft`, computed once at save
time and never recalculated from the batch afterward. Deleting one row
never shifts, renumbers, or otherwise touches any other row — deleted rows
are soft-deleted (`deleted_at`), excluded from every normal read, and their
row number becomes immediately reusable. Deleting an entire batch soft-
deletes all (and only) its own rows; other batches in the same phase are
untouched.

**Selecting a saved row** (click its rectangle on the canvas) is independent
of phase selection — the phase's own action buttons are hidden while a row
is the current selection, to keep it unambiguous which object any visible
button acts on. The row-details panel shows its batch, side/anchor,
dimensions, and position, with a two-step confirm **Delete Row** action. Row
number labels are hidden below a low zoom level to avoid illegible
overlapping text, and reappear once zoomed in far enough to read.

**Permissions** match the rest of the Greenhouse Layout editor: Administrator
and Manager can read (view rows, batches, and the Basic Data → Rows list);
only Administrator can create, edit (rename), or delete a row or batch.

**Current limitation:** an existing batch's *geometry* (side, anchor,
numbering, width, length, gap, offset) cannot be edited after it's saved —
only its name can be changed, and individual rows can only be deleted, not
repositioned or resized. To change a batch's layout, delete it and create a
new one. Full batch re-editing was deliberately left out of this first
version rather than risk the save/validation/continuation logic on a
partial implementation.

### Basic Data → Rows

The Basic Data page (`/basic-data`) has a **Rows** tab alongside **Breaks**
(`/basic-data/rows`, tab selection preserved in the URL) listing every
active greenhouse row across every phase — Row #, Phase, Batch, Orientation,
Width, Length, a Side/anchor summary, Active status, and a Delete action.
It reads the exact same `greenhouse_rows` records the map does (via the same
`GET /api/greenhouse-layout/rows` endpoint, just without a `phaseId` filter)
— there's no separate copy of row data for this page. Search matches row
number, phase name, or batch name; results can also be filtered by phase and
by active/inactive/all. Deleting a row here uses the same soft-delete as
deleting it from the map, so it disappears from both surfaces together.

## Live Greenhouse Map, Activity Row Questions & Break Area TV display

The live map shows which greenhouse rows currently have crews working
(blue), which had qualifying work completed in a chosen date range (green),
and which have neither (neutral) — derived fresh from `time_entries` on
every request, never stored on `greenhouse_rows` itself. It is split into
two pages that share one implementation:

- **`/greenhouse`** — the authenticated office controller (Administrator or
  Manager). Draft date-range/activity-filter controls drive an immediate
  live preview; nothing reaches the TV until **Publish to TV** is pressed.
- **`/greenhouse/display/:displayKey`** — the read-only TV display, reached
  by an unguessable per-display URL token, no employee login involved.

Both pages render through the same `GreenhouseLiveCanvas` component, and
both the office `GET /api/greenhouse/live` endpoint and the TV's
`GET /api/greenhouse/display/:displayKey/state` endpoint call the same
`buildLiveLandQuery` (`server/src/lib/greenhouseLiveState.ts`) — one query
shape, one place row state is defined. This is a distinct, read-only
counterpart to the editable map in Setup → Greenhouse Layout (`LandCanvas`);
that page remains the only place the map's geometry itself can be changed.

**Row state**: blue = an open work entry (optionally matching an activity
filter) that existed as of the selected range's end; green = no matching
open entry, but at least one completed qualifying work entry in the range;
neutral = neither. Blue always wins over green. An activity filter is
applied identically to both the blue and green checks, so a row that only
had *unrelated* activity completed on it is never marked green while
filtered to a different activity.

**Activity Row Questions**: an activity can be configured (Activities page →
row action → *Questions*) to ask a Greenhouse Row question before an
employee's phone lets them start it — configurable label (default "Where?")
and **Required** vs **Optional**:
- **Required** — the row picker must be used; Cancel returns to the job
  list without starting anything; Confirm requires a row be selected first.
- **Optional** — the row picker still opens (showing the configured label),
  but a **Skip — No row** action is always available and starts the
  activity immediately with no row attached. An optional question is never
  silently skipped the way "no question at all" is — the label and picker
  still appear.
- Every server-side write independently re-validates any row id a client
  supplies (real, non-deleted row in an active phase; only accepted at all
  if the activity's question permits one) — the mobile picker is a
  convenience, not the enforcement.
- Changing rows mid-activity ("Change Row" on the phone) closes the current
  segment and opens a new one on the new row, which also resets the visible
  job timer (a row change is a new logical job segment, exactly like an
  activity change). Starting and ending a break automatically resumes the
  same activity *and* the same row with no re-prompt. An auto-added break
  (scheduled break the employee worked straight through) splits the work
  entry around it while carrying the same row forward on both sides.

**Office controls**:
- **Date range** — a Monday-start month calendar supports both drag-to-select
  (mousedown → drag → mouseup) and click-click (first click = start, second
  = end, order-independent) selection, plus 8 quick presets (Today,
  Yesterday, This week, Last week, Last 7 days, This month, Last month,
  Custom range). All range/preset math is computed in `APP_TIMEZONE`
  (`server/.env` / `web/.env`'s `VITE_APP_TIMEZONE`, default
  `America/Toronto`), not the browser's local timezone.
- **Activity filter** — server-derived; only ever lists activities with real
  qualifying work in the currently selected land/range (`GET
  /api/greenhouse/available-activities`), never a static "all activities"
  list. Changing the range re-derives the list; if the previously selected
  activity no longer qualifies, the filter resets to "All activities" with
  an inline explanation rather than silently keeping a stale filter.
- **Publish workflow** — editing date range/activity/land only updates the
  office's own live preview. The **Publish to TV** button (disabled until
  something has actually changed since the last publish) writes the draft
  to the selected display; the TV picks it up on its next poll (≤10s), no
  reload. Leaving the page with unsaved changes triggers a confirmation —
  both a browser-level `beforeunload` warning (hard reload/tab-close/
  external navigation) and, since navigating between pages here is regular
  in-app routing rather than a full page load, an in-app confirmation on the
  sidebar's own nav links and Sign Out button (`UnsavedChangesContext`).
  Every date-range/publish control on the office page stays disabled until
  the currently-published configuration has finished loading, closing a
  race where a fast click could land before that seed and then get
  silently overwritten.
- A maximum 90-day custom range is enforced server-side (office preview,
  activity list, and Publish all reject a longer span) — not proven safe at
  a larger scale, kept conservative rather than assumed.

**Display tokens (TV security)**: a display is created via `npm run
create-greenhouse-display -- "<name>" "<land name or id>"` or the office
page's *New Display* form (Administrator only). Creation/regeneration
returns a 256-bit random token (`crypto.randomBytes(32)`) exactly once —
**copy it immediately**, it is never shown or logged again. Only its SHA-256
hash is ever stored (`greenhouse_displays.display_key_hash`); the raw
plaintext token never touches the database. A bad or deactivated token
returns a bare `404` (not `401`/`403`) — the same response whether the
token is wrong or the display was disabled, giving a prober no signal
either way. Regenerating a display's key immediately invalidates its old
URL. The token is a narrow read-only capability: it can only ever reach
`GET /api/greenhouse/display/:displayKey/state` (the one route that accepts
it) — it grants no access whatsoever to employee data, Inputs, Setup,
activity management, or any mutating endpoint. Employee names returned to
the TV are redacted server-side to "First L." (first name + last initial)
before the response is ever sent — a display token is a bearer credential
embedded in a URL, so this redaction happens at the actual security
boundary, not just in how the TV page happens to render it (the
authenticated office view still shows full names).

**TV display behavior**: full viewport (`position: fixed; inset: 0`), no
sidebar, no admin chrome, no editing, no page scrolling, neutral (not
green) background. The map and its phases/rows auto-fit on load and on any
resolution/window change. The published display name, activity filter, and
date range are shown in a header; a compact legend (Blue/Green/Neutral,
large/high-contrast for reading from across a break room) replaces the
office page's hover tooltips, since a TV has no mouse. It polls its state
endpoint every 10 seconds plus on focus/visibility-regain. A failed poll
never blanks the screen — the last successfully loaded map stays up with a
small "Reconnecting…" indicator, and it recovers automatically (no manual
refresh, no reload) once polling succeeds again.

**Current limitation**: in-app unsaved-changes protection on the office
page covers the sidebar's own navigation (NavLink clicks, Sign Out) — it
cannot intercept the browser's own Back/Forward buttons. This repo uses a
plain `BrowserRouter` (not a data router), and `useBlocker`/
`unstable_usePrompt` — the mechanism that *can* cover Back/Forward — require
`createBrowserRouter`/`RouterProvider`, a separate, larger routing change
left out of this milestone rather than faked.

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
      assignment (an employee may belong to any number of active groups at
      once; adding/removing one group never touches the others; history is
      preserved via `assigned_at`/`unassigned_at`), mobile activity picker
      fully server-driven and scoped to the union of the employee's own
      assignments
- [x] **Phase 7** — Desktop Inputs page: daily activity-log review with
      job-chain run grouping, end-time correction with a required reason and
      a full audit trail (`time_entry_corrections`), and a Workday details
      card — see "Daily activity-log review & correction" above
- [x] **Phase 8** — Live Greenhouse Map, Activity Row Questions, and Break
      Area TV display — see "Live Greenhouse Map, Activity Row Questions &
      Break Area TV display" above

Basic time tracking now exists, scoped tightly to what field testing needs:
an `activities` table (plus `activity_groups` and the join/assignment tables
that scope activities to employees) and a `time_entries` table recording
work/break spans per employee, enforced server-side to allow at most one open
entry per employee at a time and idempotent under duplicate/retried requests.
Payroll, row tracking, greenhouse logic, full offline background sync, and
reporting remain out of scope until explicitly scoped — see the project
brief.

**Mobile activity assignment**: an employee's phone only ever shows
activities that are active *and* belong to *any* of their currently assigned
active Activity Groups (`GET /api/mobile/activities`) — the deduplicated
union across all their groups, never a hardcoded or fallback list. An
employee with no active groups, or whose groups currently have no active
activities between them, sees "No activities have been assigned to you.
Please contact your supervisor." instead of any activity list, and the
mobile job picker is disabled until that's resolved. Every job-selection
request is revalidated server-side against the employee's current groups
regardless of what the client sends, so an activity that's been deactivated
or removed from every one of the employee's groups can never be newly
selected — including on offline-queue replay. An activity an employee is
*already* working on stays visible in their status and can still be
ended/broken out of cleanly even after it's deactivated or removed from its
group; it just won't be offered again as a new choice.

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
- **Office page unsaved-changes protection doesn't cover browser Back/
  Forward** — see "Live Greenhouse Map..." above for why (plain
  `BrowserRouter`, not a data router).
- The greenhouse live-state queries (`greenhouseLiveState.ts`,
  `greenhouseLive.ts`) filter on `time_entries.deleted_at`, a column added
  by migration `012_inputs_deletion_and_break_corrections.sql`. That
  migration belongs to a separate, still-uncommitted Inputs
  correction/deletion feature and is deliberately not part of this
  commit's migration set. The live database already has it applied, so
  this works correctly today — but a database built fresh from only this
  repo's committed migrations would be missing that column until 012 is
  committed on its own.
