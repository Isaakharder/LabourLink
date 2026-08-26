// Pure functions for deriving the mobile UI's "what's happening right now"
// view from the local SQLite event log, instead of waiting for a server
// response — the heart of the local-first rewrite (WorkSessionContext.tsx).
// Deliberately reuses MeResponse's own shape (context/WorkSessionContext.tsx)
// rather than inventing a parallel one: HomeScreen/MobileNav/ActivityTimer
// already render off that shape today, so patching the fields a new local
// event actually changes — onto the last known-good full server snapshot —
// means everything downstream keeps working unmodified, while still getting
// a genuinely immediate, no-network-wait UI update.
import { getLocalEventStore, LocalEvent } from "./localEventStore";
import {
  ActivitiesResponse,
  CarriersResponse,
  RowsResponse,
} from "./referenceDataCache";
import { CachedEmployeeSummary } from "./device";
import { CurrentActivity, MeResponse, PreviousActivity } from "../context/WorkSessionContext";

// What the caller already knows for display purposes at the moment it
// fires a local event — HomeScreen already resolves these (from its own
// loaded activities/rowLands/carriers lists, Stage 2's referenceDataCache)
// to build its own UI, e.g. the existing pendingLabel convention. Passing
// them through here avoids WorkSessionContext needing its own independent
// copy of "which activity/row/carrier has which name," which it has no way
// to look up on its own (those lists live in HomeScreen's own state).
export interface LocalDisplayInfo {
  activityName?: string | null;
  rowLabel?: string | null;
  carrierName?: string | null;
  minimumDurationMinutes?: number | null;
}

// Applies one just-appended local event on top of the last known MeResponse
// (or null on a genuinely first-ever launch with nothing cached yet — see
// the null-safe defaults below). Only the fields a given event type
// actually changes are touched; everything else (employee info, recentJobs,
// etc.) carries over from `prev` untouched, since a purely local
// computation has no way to recompute those from scratch and doesn't need
// to — the next successful sync/loadMe() reconciles the full picture
// against the server's own authoritative response anyway.
export function applyLocalEventToMe(
  prev: MeResponse | null,
  event: LocalEvent,
  display: LocalDisplayInfo
): MeResponse {
  const base: MeResponse = prev ?? {
    employee: { id: event.employeeId, firstName: "", lastName: "", preferredLanguage: null, securityRole: "Employee" },
    status: "idle",
    currentActivity: null,
    since: null,
    previousActivity: null,
    recentJobs: [],
  };

  switch (event.eventType) {
    case "work_start":
    case "activity_switch": {
      const currentActivity: CurrentActivity = {
        id: event.activityId ?? "",
        name: display.activityName ?? base.currentActivity?.name ?? "",
        startedAt: event.occurredAtUtc,
        // A genuinely NEW run starts its accumulated-before-this-entry
        // counter at zero — only break/end (resuming an interrupted run)
        // carries a nonzero value forward, see the "break_end" case below.
        // A same-activity-different-row switch is still a fresh run in
        // this local approximation (the precise "was this really a
        // continuation" chain-walking the server's groupIntoActivityRuns
        // does is reconciled in on the next real sync/loadMe(), not
        // recomputed locally).
        accumulatedWorkedSecondsBeforeCurrentEntry: 0,
        minimumDurationMinutes: display.minimumDurationMinutes ?? base.currentActivity?.minimumDurationMinutes ?? 0,
        row: event.greenhouseRowId ? { id: event.greenhouseRowId, label: display.rowLabel ?? "" } : null,
        carrier: event.carrierId ? { id: event.carrierId, name: display.carrierName ?? "" } : null,
      };
      return { ...base, status: "work", currentActivity, since: null, previousActivity: null };
    }
    case "break_start": {
      const previousActivity: PreviousActivity | null = base.currentActivity
        ? {
            id: base.currentActivity.id,
            name: base.currentActivity.name,
            accumulatedWorkedSeconds:
              base.currentActivity.accumulatedWorkedSecondsBeforeCurrentEntry +
              (new Date(event.occurredAtUtc).getTime() - new Date(base.currentActivity.startedAt).getTime()) / 1000,
          }
        : base.previousActivity;
      return { ...base, status: "break", since: event.occurredAtUtc, previousActivity, currentActivity: null };
    }
    case "break_end": {
      // Resumes the exact interrupted run — same activity/row/carrier the
      // break interrupted, per the "break resume must preserve the
      // original activity, row, carrier" requirement. event.activityId/
      // greenhouseRowId/carrierId are populated by WorkSessionContext's
      // endBreak() from base.previousActivity/currentActivity before this
      // event was even appended (see endBreak below) — never guessed here.
      const currentActivity: CurrentActivity = {
        id: event.activityId ?? base.previousActivity?.id ?? "",
        name: display.activityName ?? base.previousActivity?.name ?? "",
        startedAt: event.occurredAtUtc,
        accumulatedWorkedSecondsBeforeCurrentEntry: base.previousActivity?.accumulatedWorkedSeconds ?? 0,
        minimumDurationMinutes: display.minimumDurationMinutes ?? 0,
        row: event.greenhouseRowId ? { id: event.greenhouseRowId, label: display.rowLabel ?? "" } : null,
        carrier: event.carrierId ? { id: event.carrierId, name: display.carrierName ?? "" } : null,
      };
      return { ...base, status: "work", currentActivity, since: null, previousActivity: null };
    }
    case "end_day":
      return { ...base, status: "idle", currentActivity: null, since: null, previousActivity: null };
    default:
      return base;
  }
}

const CACHE_KEYS = {
  activities: "activities",
  rows: "greenhouse-rows",
  carriers: "carriers",
} as const;

// Builds id -> label lookups from the three reference caches ONCE, rather
// than resolveDisplayLabels' three SQLite reads PER event — foldPendingEventsOntoMe
// below can walk thousands of pending events (see the plan's "must hold
// thousands" requirement) and re-reading/re-scanning the same cached JSON
// for every single one would scale badly for no benefit, since none of
// those three caches change mid-fold.
async function buildDisplayLookup(): Promise<{
  activityName: Map<string, string>;
  rowLabel: Map<string, string>;
  carrierName: Map<string, string>;
}> {
  const store = getLocalEventStore();
  const [activitiesCached, rowsCached, carriersCached] = await Promise.all([
    store.getCachedJson<ActivitiesResponse>(CACHE_KEYS.activities),
    store.getCachedJson<RowsResponse>(CACHE_KEYS.rows),
    store.getCachedJson<CarriersResponse>(CACHE_KEYS.carriers),
  ]);

  const activityName = new Map<string, string>();
  for (const a of activitiesCached?.value.activities ?? []) activityName.set(a.id, a.name);

  const rowLabel = new Map<string, string>();
  for (const land of rowsCached?.value.lands ?? []) {
    for (const phase of land.phases) {
      for (const row of phase.rows) {
        rowLabel.set(row.id, `${phase.name} · Row ${row.rowNumber}`);
      }
    }
  }

  const carrierName = new Map<string, string>();
  for (const c of carriersCached?.value.carriers ?? []) carrierName.set(c.id, c.name);

  return { activityName, rowLabel, carrierName };
}

// Reconstructs "what is actually happening right now" by replaying every
// still-unsynced local event on top of the server's last authoritative
// MeResponse — the local half of the plan's "session state is derived
// locally, by replaying the local event log's latest state... After a
// successful sync, the server's response is compared against local state"
// design. Without this, a server response that predates a pending local
// event (the normal case for anything not yet synced — including, today,
// everything, since Stage 4's real sync endpoint doesn't exist yet) would
// silently overwrite genuine in-progress work with stale "idle" server
// truth, e.g. after a cold app restart. A no-op whenever there's nothing
// pending, so the fully-synced steady state is unchanged from before.
//
// Bounded by a timeout — the local store's web backend (jeep-sqlite,
// WASM + IndexedDB) has a documented category of WebKit bug where iOS
// Safari's standalone "Add to Home Screen" PWA mode can hang an IndexedDB
// operation forever with no error ever thrown (reproduced: a fresh
// pairing on iOS stuck permanently on "Loading..." — this call, normally
// well under 100ms, was the one thing standing between a successful
// /api/mobile/me response and setMe() ever being called). A real device on
// a healthy browser resolves this in milliseconds, so the timeout is only
// ever felt on the broken path — and falling back to the untouched server
// response there is always safe, just possibly missing an unsynced local
// event's effect on this one render (it still exists on disk and will
// sync/fold normally the next time this succeeds).
const LOCAL_STORE_FOLD_TIMEOUT_MS = 4000;

export async function foldPendingEventsOntoMe(deviceId: string, base: MeResponse): Promise<MeResponse> {
  let pending: LocalEvent[];
  try {
    pending = await Promise.race([
      getLocalEventStore().getPendingEvents(deviceId, 5000),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("local event store timed out")), LOCAL_STORE_FOLD_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.error("[local-session-state] foldPendingEventsOntoMe: local store unavailable, using server response as-is:", err);
    return base;
  }
  if (pending.length === 0) return base;

  const lookup = await buildDisplayLookup();
  let result = base;
  for (const event of pending) {
    const display: LocalDisplayInfo = {
      activityName: event.activityId ? (lookup.activityName.get(event.activityId) ?? null) : null,
      rowLabel: event.greenhouseRowId ? (lookup.rowLabel.get(event.greenhouseRowId) ?? null) : null,
      carrierName: event.carrierId ? (lookup.carrierName.get(event.carrierId) ?? null) : null,
      minimumDurationMinutes: null,
    };
    result = applyLocalEventToMe(result, event, display);
  }
  return result;
}

// The durable "last known base" a cold start folds pending events onto —
// deliberately the RAW server snapshot (never itself folded/optimistic),
// so a restart always rebuilds today's actual status from the durable
// local event ledger on top of it, rather than trusting a possibly-stale
// pre-folded snapshot that could have been written moments before an OS
// process kill and never updated again. Single global key, same convention
// as CACHE_KEYS above (one physical device, one active session).
const SERVER_ME_SNAPSHOT_CACHE_KEY = "last-server-me";

// Called every time a real server /me response is applied (see
// WorkSessionContext.tsx's applyMeResponse/acknowledgeReassignment) — the
// one place a cold start's restore base gets refreshed. Fire-and-forget by
// convention (same as fetchWithCache's cache write above): a slow/failed
// write here must never delay or fail the live UI update that already
// happened from the response itself.
export async function persistServerMeSnapshot(me: MeResponse): Promise<void> {
  await getLocalEventStore().setCachedJson(SERVER_ME_SNAPSHOT_CACHE_KEY, me);
}

// Reconstructs "what is happening right now" entirely from durable local
// storage — no network call, no wait on /api/mobile/me — for use at cold
// start / after an Android process restart, before the server has been
// reached this session at all. Folds every still-pending local event
// (work/break/row changes made before the restart, not yet synced) on top
// of the last real server snapshot this device ever received, using the
// exact same fold used to reconcile a live server response
// (foldPendingEventsOntoMe) — so a restart can never show a status that's
// missing an action the employee already durably committed.
//
// Falls back to a bare idle snapshot built from the cached employee
// identity (device.ts) when this device has never received a real server
// response yet (e.g. paired, then killed before the first /me landed) —
// still folds pending events on top, so even that first-ever session's
// local actions aren't lost. Returns null only when there is truly nothing
// to restore (never paired on this device) — the caller's existing
// "Loading..." state is the honest answer there.
export async function restoreLocalSessionState(
  deviceId: string,
  cachedEmployee: CachedEmployeeSummary | null
): Promise<MeResponse | null> {
  const store = getLocalEventStore();
  let base: MeResponse | null = null;
  try {
    const cached = await store.getCachedJson<MeResponse>(SERVER_ME_SNAPSHOT_CACHE_KEY);
    base = cached?.value ?? null;
  } catch (err) {
    console.error("[local-session-state] restoreLocalSessionState: failed reading last server snapshot:", err);
  }

  if (!base) {
    if (!cachedEmployee) return null;
    base = {
      employee: {
        id: cachedEmployee.employeeId,
        firstName: cachedEmployee.firstName,
        lastName: cachedEmployee.lastName,
        preferredLanguage: cachedEmployee.preferredLanguage ?? null,
        securityRole: "Employee",
      },
      status: "idle",
      currentActivity: null,
      since: null,
      previousActivity: null,
      recentJobs: [],
    };
  }

  // Bounded by foldPendingEventsOntoMe's own LOCAL_STORE_FOLD_TIMEOUT_MS —
  // a broken local store here falls back to `base` (still perfectly usable:
  // just missing whatever's pending, exactly like the base case fold
  // already handles) rather than leaving the caller waiting.
  return foldPendingEventsOntoMe(deviceId, base);
}
