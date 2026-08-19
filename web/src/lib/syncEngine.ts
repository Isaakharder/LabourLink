// Background synchronization — sends locally-durable pending_events to the
// server in ordered batches and reconciles the result. This is Stage 4: the
// server-side event ledger + batch endpoint (POST /api/mobile/sync/events)
// now exist (server/src/routes/mobileTime.ts), so trySyncSoon() below does
// real work. Every local-first action already worked without this — Stage
// 3's appendEvent() is durable and immediate regardless of whether a sync
// ever succeeds — this file is what actually gets a pending event off the
// phone and onto the server.
//
// Kept as its own module (not inlined into WorkSessionContext) so the
// native lifecycle triggers below can be wired independently of any one
// React component's mount/unmount, and so a background-triggered sync (the
// phone regaining signal with no screen open, or a native app-resume event)
// doesn't need a mounted WorkSessionProvider to fire at all — it just needs
// to notify one once it's done (see onSyncSettled).
import { getLocalEventStore, LocalEvent, SyncResultStatus } from "./localEventStore";
import { getOrCreateDeviceIdentifier } from "./device";
import { api, isServerUnreachableError } from "./api";
import { isNativePlatform } from "./platform";
import { singleFlight } from "./singleFlight";

// Oldest-first, capped — matches the plan's "ordered batches, not one
// request per item" requirement. A queue holding thousands of events (a
// multi-day offline stretch) drains itself over several batches (see the
// "more pending after this batch" re-schedule in runSync below), never one
// giant request.
const BATCH_SIZE = 50;
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

let consecutiveFailures = 0;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;

// A stable per-device fraction in [0, 1), derived once from the device's
// own persistent identifier — used to spread retry backoff across devices
// so 35 phones losing and regaining signal together don't all retry in
// lockstep against the server at the same instant. Deliberately NOT
// re-randomized per attempt: a stable-per-device offset is enough to break
// synchronization between devices while still being deterministic (useful
// for debugging "why did this device wait exactly that long").
let jitterFraction: number | null = null;
function getJitterFraction(): number {
  if (jitterFraction === null) {
    const id = getOrCreateDeviceIdentifier();
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    jitterFraction = (hash >>> 0) / 0xffffffff;
  }
  return jitterFraction;
}

function nextBackoffMs(): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** consecutiveFailures);
  // +/-30% spread around the exponential value.
  const spread = 0.7 + getJitterFraction() * 0.6;
  return Math.round(exp * spread);
}

interface SyncEventWire {
  clientEventId: string;
  deviceSeq: number;
  eventType: string;
  occurredAtUtc: string;
  localTzOffsetMinutes: number;
  activityId: string | null;
  greenhouseRowId: string | null;
  carrierId: string | null;
  answers: Record<string, unknown> | null;
}

function toWire(event: LocalEvent): SyncEventWire {
  return {
    clientEventId: event.clientEventId,
    deviceSeq: event.deviceSeq,
    eventType: event.eventType,
    occurredAtUtc: event.occurredAtUtc,
    localTzOffsetMinutes: event.localTzOffsetMinutes,
    activityId: event.activityId ?? null,
    greenhouseRowId: event.greenhouseRowId ?? null,
    carrierId: event.carrierId ?? null,
    answers: (event.answers as Record<string, unknown> | null) ?? null,
  };
}

// Subscribers notified after every sync attempt settles (success, partial
// success, or failure) — WorkSessionContext uses this to refresh its
// pending-count badge and re-run the local-first-aware loadMe() reconcile
// even when the sync that just happened was triggered natively (app
// resume, network restoration) with no user interaction and no guarantee a
// WorkSessionProvider instance was even involved in starting it.
type SyncSettledListener = () => void;
const settledListeners = new Set<SyncSettledListener>();
export function onSyncSettled(listener: SyncSettledListener): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}
function notifySettled(): void {
  for (const listener of settledListeners) listener();
}

async function runSync(): Promise<void> {
  if (!navigator.onLine) return;
  const deviceId = getOrCreateDeviceIdentifier();
  const store = getLocalEventStore();
  const pending = await store.getPendingEvents(deviceId, BATCH_SIZE);
  if (pending.length === 0) {
    consecutiveFailures = 0;
    return;
  }

  const attemptedAt = new Date().toISOString();
  try {
    const response = await api<{ results: { clientEventId: string; status: SyncResultStatus; detail?: unknown }[] }>(
      "/api/mobile/sync/events",
      { method: "POST", body: JSON.stringify({ events: pending.map(toWire) }) }
    );
    for (const result of response.results) {
      await store.markSyncResult(result.clientEventId, { clientEventId: result.clientEventId, status: result.status, detail: result.detail });
    }
    consecutiveFailures = 0;
    await store.setSyncMeta(deviceId, { lastSuccessfulSyncAt: attemptedAt, lastAttemptedSyncAt: attemptedAt, lastError: null });
    notifySettled();

    // Either more than one batch's worth was pending, or a sequence_gap/
    // retryable_failure this round left something behind that a later
    // attempt might now clear (e.g. the gap-filling event arrived in this
    // same batch) — keep draining without waiting for the next external
    // trigger.
    const remaining = await store.getPendingCount(deviceId);
    if (remaining > 0) scheduleRetry(0);
  } catch (err) {
    consecutiveFailures = Math.min(consecutiveFailures + 1, 10);
    if (!isServerUnreachableError(err)) {
      console.error("[sync-engine] batch submit failed unexpectedly:", err);
    }
    const prevMeta = await store.getSyncMeta(deviceId);
    await store.setSyncMeta(deviceId, {
      lastSuccessfulSyncAt: prevMeta.lastSuccessfulSyncAt,
      lastAttemptedSyncAt: attemptedAt,
      lastError: err instanceof Error ? err.message : String(err),
    });
    notifySettled();
    scheduleRetry(nextBackoffMs());
  }
}

const runSyncExclusive = singleFlight(runSync);

function scheduleRetry(delayMs: number): void {
  if (backoffTimer !== null) return;
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    void runSyncExclusive();
  }, delayMs);
}

// Called after every local commit (online or offline — a genuine no-op
// instant no-op when offline, since runSync's own navigator.onLine check
// returns immediately) and by every trigger below. Safe to call as often as
// convenient: singleFlight collapses overlapping calls, and an empty queue
// is a cheap one-row COUNT query.
export async function trySyncSoon(): Promise<void> {
  await runSyncExclusive();
}

// True once a sync attempt has failed at least twice in a row without a
// successful attempt in between — the "Sync problem" indicator state
// (HomeScreen/SettingsScreen), distinct from ordinary "N pending" (which
// covers the very first retry, still well within normal backoff/jitter and
// not yet worth alarming anyone about).
export function hasSyncProblem(): boolean {
  return consecutiveFailures >= 2;
}

let triggersInitialized = false;

// Wires the native Android lifecycle/network signals the plan calls for,
// beyond the browser 'online'/visibilitychange triggers WorkSessionContext
// already has (those remain in place and still fire on native WebView too
// — this ADDS the more reliable native-side signals on top, it doesn't
// replace them). Honest caveat, not just a code comment: Android can and
// will suspend or kill a fully backgrounded process — @capacitor/app's
// 'resume' event only fires once the app is actually foregrounded again,
// and @capacitor/network's listener only fires while the process is alive
// to receive it. There is no guaranteed real-time sync while the app is
// backgrounded; what this buys is "sync starts immediately on the triggers
// that DO reach a live process," not a background service.
export async function initSyncLifecycleTriggers(): Promise<void> {
  if (triggersInitialized || !isNativePlatform()) return;
  triggersInitialized = true;

  try {
    const { Network } = await import("@capacitor/network");
    Network.addListener("networkStatusChange", (status) => {
      if (status.connected) void trySyncSoon();
    });
  } catch (err) {
    console.error("[sync-engine] failed to wire native Network listener:", err);
  }

  try {
    const { App } = await import("@capacitor/app");
    App.addListener("appStateChange", (state) => {
      if (state.isActive) void trySyncSoon();
    });
    App.addListener("resume", () => void trySyncSoon());
  } catch (err) {
    console.error("[sync-engine] failed to wire native App lifecycle listener:", err);
  }
}
