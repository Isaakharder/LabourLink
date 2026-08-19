import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useDevicePairing } from "./DevicePairingContext";
import { api, ApiError, getPermanentDeviceAuthErrorCode, isServerUnreachableError } from "../lib/api";
import { getCachedEmployeeSummary, getOrCreateDeviceIdentifier } from "../lib/device";
import { Language, resolveLanguage, t, translateServerMessage } from "../lib/i18n";
import { detectReassignment } from "../lib/reassignment";
import { getLocalEventStore, LocalEventType, logCheckpoint } from "../lib/localEventStore";
import { applyLocalEventToMe, foldPendingEventsOntoMe, LocalDisplayInfo } from "../lib/localSessionState";
import { resolveDisplayLabels } from "../lib/referenceDataCache";
import { hasSyncProblem, onSyncSettled, trySyncSoon } from "../lib/syncEngine";
import { QuestionAnswer } from "../lib/activityQuestionTypes";
import { RecentJob } from "../components/mobile/RecentJobsCard";
import { uuid } from "../lib/uuid";

// Selecting a job/break/end-day must NEVER hang the UI indefinitely — see
// commitLocalEvent's own comment for the real production incident
// (tapping "General" on iOS Safari's PWA left the job sheet open, every
// option gray, forever) this exists to bound. localEventStore.ts's web
// path (webEventJournal.ts) already has its own internal open/transaction
// timeouts, but this is an explicit, independent outer bound around the
// WHOLE local commit (store write + display-label resolution + `me`
// update + pending-count refresh) — defense in depth, not a replacement
// for those, and generous enough (well above the journal's own worst-case
// ~6s) that it only ever fires when something is genuinely stuck.
const LOCAL_COMMIT_TIMEOUT_MS = 8000;

class LocalCommitTimeoutError extends Error {
  constructor() {
    super("local commit timed out");
    this.name = "LocalCommitTimeoutError";
  }
}

function withCommitTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocalCommitTimeoutError()), LOCAL_COMMIT_TIMEOUT_MS);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface CurrentActivity {
  id: string;
  name: string;
  startedAt: string;
  // Seconds accumulated across earlier segments of the same continuous job
  // chain (same activity, separated only by breaks) before this entry — the
  // live elapsed time since startedAt is added on top by ActivityTimer.
  accumulatedWorkedSecondsBeforeCurrentEntry: number;
  // The currently-running activity's own configured minimum — used by
  // lib/nfcSwitchWarning.ts's client-side pre-check so a scan-triggered
  // switch attempt can warn before reaching the minimum without a round
  // trip (the server independently re-checks the same rule).
  minimumDurationMinutes: number;
  row: { id: string; label: string } | null;
  carrier: { id: string; name: string } | null;
}

export interface PreviousActivity {
  id: string;
  name: string;
  // Running total for the whole chain up through the segment that just
  // closed when this break started — not just that one segment's length.
  accumulatedWorkedSeconds: number;
}

export interface MeResponse {
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    preferredLanguage: string | null;
    // Display-only client-side (e.g. gating the mobile "Admin Mode" section)
    // — every server route that actually needs this re-checks it itself.
    securityRole: string;
  };
  status: "idle" | "work" | "break";
  currentActivity: CurrentActivity | null;
  since: string | null;
  previousActivity: PreviousActivity | null;
  recentJobs: RecentJob[];
}

// While the server hasn't yet been reached this poll cycle, retry this
// often — only runs while serverReachable is false (see the effect below),
// so a healthy app never has a background timer running at all. This is a
// RECONCILIATION poll (catching up the full authoritative MeResponse —
// employee info, recentJobs, precise accumulated seconds) — it has nothing
// to do with whether local actions work: those are always immediate and
// durable regardless of server reachability, see perform()/commitLocalEvent
// below.
const RECONNECT_POLL_INTERVAL_MS = 15000;

interface PerformOptions {
  pendingLabel?: string;
  // Home-screen-local UI reset (closing the activity picker / question
  // flow sheet) — irrelevant to break/end-day callers, which have no such
  // sheets open when they call perform.
  onResolved?: () => void;
  // No longer invoked — kept on the interface so existing callers (e.g.
  // HomeScreen's switch-warning handling) don't need changes yet. The
  // synchronous 409 round trip this used to intercept doesn't happen
  // anymore: local actions commit immediately and reconcile against the
  // server later (see Conflict handling, Stage 5), not via a blocking
  // pre-commit rejection. checkSwitchWarning's own CLIENT-SIDE pre-check
  // (lib/nfcSwitchWarning.ts, which runs in HomeScreen BEFORE perform() is
  // ever called) is what still catches the common same-row/minimum-
  // duration cases up front.
  onConflict?: (err: ApiError) => boolean;
  // Fired unconditionally once this call is fully finished.
  onSettled?: () => void;
  // What HomeScreen already knows about the activity/row/carrier being
  // committed (it just resolved these to render its own picker UI) — used
  // to build an immediately-readable optimistic MeResponse instead of
  // leaving names blank until the next sync. Falls back to whatever's in
  // Stage 2's local reference-data cache when omitted (e.g. NFC-scan-
  // triggered switches, which know the ids but not necessarily the exact
  // display strings HomeScreen would have shown).
  localDisplay?: LocalDisplayInfo;
}

interface WorkSessionContextValue {
  me: MeResponse | null;
  // Resolved from the currently-cached employee's Preferred language (see
  // lib/i18n.ts's resolveLanguage) — the single source every mobile Home/
  // Stats component reads instead of each re-deriving it from
  // DevicePairingContext itself.
  language: Language;
  // True once a real /api/mobile/me response has been received this
  // session — gates every server-dependent action.
  verified: boolean;
  busy: boolean;
  online: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  // Non-null only when the LAST perform()/startBreak/endBreak call timed
  // out locally (never for a genuine rejection) — calling it retries the
  // exact same tap with the exact same idempotencyKey, so it can never
  // produce a duplicate. See commitLocalEvent's own comment for the real
  // incident this exists to recover from.
  retryAction: (() => void) | null;
  pending: number;
  // True once syncEngine.ts has failed at least two consecutive attempts
  // with no success in between — see lib/syncIndicator.ts's
  // computeSyncIndicatorState, the single place this and `pending`/`online`
  // combine into what the sync indicator actually shows.
  syncProblem: boolean;
  pendingActivityName: string | null;
  // Set whenever a server response's employee id differs from the locally
  // cached one — an admin reassigned this physical device to someone else
  // since the last time it checked in. Holds the *new* MeResponse, not yet
  // applied to `me`/the cached employee summary (see acknowledgeReassignment
  // and ReassignmentOverlay, which is what actually renders this).
  pendingReassignment: MeResponse | null;
  acknowledgeReassignment: () => void;
  loadMe: () => void;
  handleApiError: (err: unknown) => boolean;
  perform: (path: string, body: Record<string, unknown>, options?: PerformOptions) => Promise<void>;
  flush: () => Promise<void>;
  startBreak: () => void;
  endBreak: () => void;
  endDayConfirmOpen: boolean;
  endDaySubmitting: boolean;
  endDayError: string | null;
  // Same idea as `retryAction` above, scoped to the end-day confirm
  // dialog specifically so it never surfaces on an unrelated screen.
  endDayRetryAction: (() => void) | null;
  openEndDayConfirm: () => void;
  closeEndDayConfirm: () => void;
  confirmEndDay: () => void;
}

const WorkSessionContext = createContext<WorkSessionContextValue | undefined>(undefined);

// Owns everything about "what is the employee's work status and what can
// they do about it right now" — shared between HomeScreen (the activity /
// question-flow UI) and MobileLayout's bottom nav (End Work / Start Break /
// End Break), which needs the same status and actions from every mobile
// screen, not just Home. Mounted once inside MobileLayout, which persists
// across mobile route changes, so switching tabs never interrupts a poll or
// resets status.
//
// LOCAL-FIRST: every action below (perform/startBreak/endBreak/
// confirmEndDay) writes to the durable local SQLite event log
// (lib/localEventStore.ts) FIRST, updates `me` from that local write
// immediately, and only THEN fires an unawaited background sync attempt
// (lib/syncEngine.ts). This is the SAME path online or offline — there is
// no separate "try the network, fall back to a queue on failure" branch
// anymore (that was the old design; see git history). loadMe()/the
// reconnect poll below are a separate, ongoing RECONCILIATION path that
// fetches the server's own authoritative view and reconciles it — that's
// what keeps employee info/recentJobs/precise accumulated-seconds correct,
// but it never blocks or gates the immediate local UI update.
export function WorkSessionProvider({ children }: { children: ReactNode }) {
  const { cachedEmployee, markUnpaired, serverReachable, setServerReachable, refreshCachedEmployee } =
    useDevicePairing();
  // The single source of truth for "what language is Home/Stats in right
  // now" — cachedEmployee (not `me`) so this stays correct even before the
  // first /me response of a session lands, exactly the same offline-safe
  // guarantee cachedEmployee already gives the employee's name (see
  // HomeScreen's `!me && cachedEmployee` render branch). refreshCachedEmployee
  // is called synchronously from applyMeResponse/acknowledgeReassignment
  // below every time `me` changes, so the two are never observably out of
  // sync.
  const language = resolveLanguage(cachedEmployee?.preferredLanguage);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set only when the LAST local commit failed by timing out (never for a
  // genuine rejection — those aren't safely retryable the same way). Holds
  // a closure that re-runs the exact same attempt, idempotencyKey and all,
  // so retrying can never produce a duplicate — see commitLocalEvent's
  // clientEventId parameter and each of perform/startBreak/endBreak/
  // confirmEndDay below, which all generate their id ONCE outside the
  // retryable closure, not fresh on every attempt.
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [syncProblem, setSyncProblem] = useState(false);
  const [pendingActivityName, setPendingActivityName] = useState<string | null>(null);
  const [endDayConfirmOpen, setEndDayConfirmOpen] = useState(false);
  const [endDaySubmitting, setEndDaySubmitting] = useState(false);
  const [endDayError, setEndDayError] = useState<string | null>(null);
  const [endDayRetryAction, setEndDayRetryAction] = useState<(() => void) | null>(null);
  const [pendingReassignment, setPendingReassignment] = useState<MeResponse | null>(null);

  const refreshPendingCount = useCallback(async () => {
    const deviceId = getOrCreateDeviceIdentifier();
    const count = await getLocalEventStore().getPendingCount(deviceId);
    setPending(count);
  }, []);

  useEffect(() => {
    void refreshPendingCount();
  }, [refreshPendingCount]);

  // The single place every server response carrying an `employee` gets
  // applied — loadMe and acknowledgeReassignment funnel through this
  // rather than each setting me/verified/the cached employee directly, so
  // reassignment can never be missed from one of those call sites just
  // because it was added to another. Compares against the *persisted*
  // cached employee (device.ts), not React state, so this can't miss a
  // reassignment that happened before this tab of WorkSessionProvider ever
  // mounted. When a reassignment is detected, `result` is held in
  // `pendingReassignment` instead of applied — me/verified/the cached
  // employee summary stay exactly as they were until acknowledgeReassignment
  // runs. Returns whether it applied immediately.
  const applyMeResponse = useCallback(
    (result: MeResponse): boolean => {
      const cachedEmployeeId = getCachedEmployeeSummary()?.employeeId ?? null;
      if (detectReassignment(cachedEmployeeId, result.employee.id)) {
        setPendingReassignment(result);
        return false;
      }
      setMe(result);
      setVerified(true);
      setServerReachable(true);
      refreshCachedEmployee({
        employeeId: result.employee.id,
        firstName: result.employee.firstName,
        lastName: result.employee.lastName,
        preferredLanguage: result.employee.preferredLanguage,
        lastVerifiedAt: new Date().toISOString(),
      });
      return true;
    },
    [refreshCachedEmployee, setServerReachable]
  );

  const acknowledgeReassignment = useCallback(() => {
    if (!pendingReassignment) return;
    const result = pendingReassignment;
    setPendingReassignment(null);
    setMe(result);
    setVerified(true);
    setServerReachable(true);
    // Includes the new employee's preferredLanguage — this is the one place
    // a reassignment actually takes local effect (see ReassignmentOverlay:
    // the overlay is shown, not applied, until this runs), so it's also the
    // one place the mobile Home/Stats language switches to match whoever is
    // now holding the phone, immediately, not on the next /me poll.
    refreshCachedEmployee({
      employeeId: result.employee.id,
      firstName: result.employee.firstName,
      lastName: result.employee.lastName,
      preferredLanguage: result.employee.preferredLanguage,
      lastVerifiedAt: new Date().toISOString(),
    });
  }, [pendingReassignment, refreshCachedEmployee, setServerReachable]);

  // The one place every mobile screen decides what a caught error actually
  // means: a confirmed permanent device-auth code clears pairing; a network
  // failure or 5xx means the server just wasn't reached (never touches
  // pairing, never overwrites `me`/the cached employee); anything else is a
  // real, specific rejection the caller should surface. Returns true when
  // the error was fully handled so callers know not to also show a generic
  // error for it.
  const handleApiError = useCallback(
    (err: unknown): boolean => {
      const permanentCode = getPermanentDeviceAuthErrorCode(err);
      if (permanentCode) {
        markUnpaired(permanentCode);
        return true;
      }
      if (isServerUnreachableError(err)) {
        setServerReachable(false);
        return true;
      }
      setServerReachable(true); // a real response came back — the server is up
      return false;
    },
    [markUnpaired, setServerReachable]
  );

  // RECONCILIATION — fetches the server's own authoritative view, then
  // re-applies (folds) any still-unsynced local events on top of it before
  // committing to `me`. The fold is what stops a stale server response
  // (anything that predates a pending local event — today, that's
  // EVERYTHING, since Stage 4's real sync endpoint doesn't exist yet) from
  // clobbering genuine in-progress local work, e.g. on a cold app restart
  // where `me` starts null and this is the very first thing that sets it.
  // Never blocks/gates a local action; called after a successful sync
  // (Stage 4) and on the same mount/reconnect/foreground triggers as before.
  const loadMe = useCallback(() => {
    api<MeResponse>("/api/mobile/me")
      .then(async (res) => {
        const deviceId = getOrCreateDeviceIdentifier();
        const merged = await foldPendingEventsOntoMe(deviceId, res);
        applyMeResponse(merged);
      })
      .catch((err) => {
        if (!handleApiError(err)) setError(t(language, "couldNotLoadStatus"));
      });
  }, [applyMeResponse, handleApiError, language]);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  // Runs only while the server hasn't been reached — an app left open on
  // screen through a server restart/deploy must reconnect on its own, not
  // only when the tab happens to regain focus or the browser's own
  // online/offline events happen to fire. Stops itself the moment loadMe
  // succeeds and serverReachable flips back.
  useEffect(() => {
    if (serverReachable) return;
    const interval = window.setInterval(loadMe, RECONNECT_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [serverReachable, loadMe]);

  // Manual sync trigger — Settings' "Sync now" button and the network-
  // restoration listener below both call this. Reconciles via loadMe()
  // afterward regardless of whether the sync attempt itself found anything
  // to send, so "Sync now" also doubles as a manual status refresh.
  const flush = useCallback(async () => {
    await trySyncSoon();
    await refreshPendingCount();
    loadMe();
  }, [refreshPendingCount, loadMe]);

  useEffect(() => {
    function goOnline() {
      setOnline(true);
      void flush();
    }
    function goOffline() {
      setOnline(false);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    if (navigator.onLine) void flush();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flush]);

  // A background sync can be triggered by syncEngine.ts's own native
  // lifecycle listeners (app resume, network restoration) with no user
  // interaction and no guarantee this provider instance started it — this
  // is what keeps the pending-count badge and the local-first-aware
  // reconciled `me` state (see loadMe's foldPendingEventsOntoMe) fresh
  // regardless of what actually triggered the sync that just settled.
  useEffect(() => {
    return onSyncSettled(() => {
      void refreshPendingCount();
      setSyncProblem(hasSyncProblem());
      loadMe();
    });
  }, [refreshPendingCount, loadMe]);

  // The one place every local-first action actually commits: durable
  // local write (target <100ms) -> immediate `me` update from that same
  // event (target <250ms total) -> pending count refresh -> unawaited
  // background sync kick-off. Every action below (perform/startBreak/
  // endBreak/confirmEndDay) funnels through this — the single shared path
  // regardless of which UI action triggered it or whether the device is
  // online. Selecting a job/break/end-day NEVER awaits the server here —
  // the only awaited work is the local store write, resolving display
  // labels (a local reference-data cache lookup), and this function's own
  // synchronous state updates; trySyncSoon() at the end is deliberately
  // unawaited (void).
  //
  // Real production incident this is now hardened against: on iOS
  // Safari's standalone PWA, tapping "General" left the job sheet open,
  // every option gray, and the UI never recovered — traced to the local
  // store's underlying connection hanging indefinitely with no timeout
  // anywhere in the chain, so this async function itself never settled,
  // which means the CALLER's try/finally (perform/startBreak/endBreak/
  // confirmEndDay, all of which already had one) never ran either — a
  // hang isn't a rejection, and finally only runs once the awaited
  // promise actually SETTLES. localEventStore.ts's web path now has its
  // own internal timeouts that self-heal instead of hanging (see
  // webEventJournal.ts), and withCommitTimeout below adds an explicit,
  // independent outer bound around the whole local commit as defense in
  // depth, so this function is now GUARANTEED to settle within
  // LOCAL_COMMIT_TIMEOUT_MS no matter what.
  //
  // clientEventId is accepted (not always freshly minted) so a caller can
  // retry the exact same logical tap after a timeout without risking a
  // duplicate: appendEvent detects an existing event with the same id and
  // returns it as-is rather than inserting a second one.
  const commitLocalEventInner = useCallback(
    async (
      eventType: LocalEventType,
      occurredAtUtc: string,
      fields: {
        activityId?: string | null;
        greenhouseRowId?: string | null;
        carrierId?: string | null;
        answers?: Record<string, QuestionAnswer> | null;
      },
      display: LocalDisplayInfo,
      clientEventId: string
    ) => {
      const deviceId = getOrCreateDeviceIdentifier();
      const employeeId = me?.employee.id ?? getCachedEmployeeSummary()?.employeeId ?? "";
      const store = getLocalEventStore();

      logCheckpoint(clientEventId, "commitLocalEvent:store-write-start", { eventType });
      const event = await store.appendEvent({
        deviceId,
        employeeId,
        eventType,
        occurredAtUtc,
        activityId: fields.activityId ?? null,
        greenhouseRowId: fields.greenhouseRowId ?? null,
        carrierId: fields.carrierId ?? null,
        answers: fields.answers ?? null,
        // Density snapshotting still happens server-side at sync time for
        // now (same as today's openEntry() resolveDensitySnapshot) — a
        // client-side frozen snapshot captured from the reference cache is
        // a Stage 6 refinement, not required for the local-first write/UI
        // update itself to work correctly.
        densitySnapshot: null,
        configRevision: null,
        clientEventId,
      });
      logCheckpoint(clientEventId, "commitLocalEvent:store-write-committed", { deviceSeq: event.deviceSeq });

      setMe((prev) => applyLocalEventToMe(prev, event, display));
      setPendingActivityName(null);
      logCheckpoint(clientEventId, "commitLocalEvent:ui-state-updated");

      await refreshPendingCount();
      void trySyncSoon();
      logCheckpoint(clientEventId, "commitLocalEvent:background-sync-scheduled");
    },
    [me, refreshPendingCount]
  );

  const commitLocalEvent = useCallback(
    (
      eventType: LocalEventType,
      occurredAtUtc: string,
      fields: {
        activityId?: string | null;
        greenhouseRowId?: string | null;
        carrierId?: string | null;
        answers?: Record<string, QuestionAnswer> | null;
      },
      display: LocalDisplayInfo,
      clientEventId: string = uuid()
    ) => withCommitTimeout(commitLocalEventInner(eventType, occurredAtUtc, fields, display, clientEventId)),
    [commitLocalEventInner]
  );

  // clientEventId is resolved ONCE per logical tap — reused verbatim by
  // performInternal's own retry closure below, never regenerated on
  // retry, so a timed-out-then-retried tap can only ever produce one
  // event (appendEvent detects the existing clientEventId and returns it
  // as-is rather than inserting a second one).
  const performInternal = useCallback(
    async (path: string, body: Record<string, unknown>, options: PerformOptions | undefined, clientEventId: string) => {
      setBusy(true);
      setError(null);
      logCheckpoint(clientEventId, "perform:tap-handler-entered", { path });
      try {
        const answers = (body.answers as Record<string, QuestionAnswer> | undefined) ?? {};
        const rowAnswer = Object.values(answers).find((a) => a.questionType === "greenhouse_row");
        const carrierAnswer = Object.values(answers).find((a) => a.questionType === "carrier");
        const activityId = (body.activityId as string | undefined) ?? null;
        const greenhouseRowId = rowAnswer?.greenhouseRowId ?? null;
        const carrierId = carrierAnswer?.carrierId ?? null;

        let eventType: LocalEventType;
        if (path === "/api/mobile/time-entries/break/start") eventType = "break_start";
        else if (path === "/api/mobile/time-entries/break/end") eventType = "break_end";
        else eventType = me?.status === "work" ? "activity_switch" : "work_start";

        const occurredAtUtc =
          (body.clientStartedAt as string | undefined) ?? (body.clientEndedAt as string | undefined) ?? new Date().toISOString();

        const display: LocalDisplayInfo =
          options?.localDisplay ?? (await resolveDisplayLabels(activityId, greenhouseRowId, carrierId));
        if (options?.pendingLabel && !display.activityName) display.activityName = options.pendingLabel;

        await commitLocalEvent(eventType, occurredAtUtc, { activityId, greenhouseRowId, carrierId, answers }, display, clientEventId);
        setRetryAction(null);
        options?.onResolved?.();
      } catch (err) {
        if (err instanceof LocalCommitTimeoutError) {
          console.error("[work-session] local commit timed out:", err);
          setError(t(language, "localCommitTimedOut"));
          setRetryAction(() => () => {
            void performInternal(path, body, options, clientEventId);
          });
        } else {
          console.error("[work-session] local commit failed:", err);
          setError(t(language, "somethingWentWrong"));
        }
      } finally {
        setBusy(false);
        logCheckpoint(clientEventId, "perform:busy-cleared");
        options?.onSettled?.();
      }
    },
    [commitLocalEvent, me, language]
  );

  const perform = useCallback(
    async (path: string, body: Record<string, unknown>, options?: PerformOptions) => {
      const clientEventId = (body.idempotencyKey as string | undefined) ?? uuid();
      await performInternal(path, body, options, clientEventId);
    },
    [performInternal]
  );

  // clientStartedAt/clientEndedAt: the phone's own clock reading of this
  // exact tap, captured before the local commit even happens — this is the
  // occurrence time frozen into the local event (and, eventually, the
  // server's time_entries row) regardless of how long it sits pending
  // before syncing. See localEventStore.ts's NewLocalEvent.occurredAtUtc.
  const startBreakInternal = useCallback(
    async (clientEventId: string) => {
      setBusy(true);
      setError(null);
      logCheckpoint(clientEventId, "startBreak:tap-handler-entered");
      try {
        await commitLocalEvent("break_start", new Date().toISOString(), {}, {}, clientEventId);
        setRetryAction(null);
      } catch (err) {
        if (err instanceof LocalCommitTimeoutError) {
          console.error("[work-session] break start timed out:", err);
          setError(t(language, "localCommitTimedOut"));
          setRetryAction(() => () => {
            void startBreakInternal(clientEventId);
          });
        } else {
          console.error("[work-session] break start failed:", err);
          setError(t(language, "somethingWentWrong"));
        }
      } finally {
        setBusy(false);
        logCheckpoint(clientEventId, "startBreak:busy-cleared");
      }
    },
    [commitLocalEvent, language]
  );

  // Returns startBreakInternal's real promise (TypeScript's `() => void`
  // interface type permits this — a fire-and-forget UI caller just
  // ignores the return value, same as before this file's changes; a
  // caller that DOES want to await full completion, e.g. a test, still
  // can).
  const startBreak = useCallback(() => startBreakInternal(uuid()), [startBreakInternal]);

  // Resumes the exact interrupted run — same activity/row/carrier the break
  // interrupted, per "break resume must preserve the original activity,
  // row, carrier." Resolved from the local event log's own most recent
  // WORK event (getLatestWorkEventForDevice), not from MeResponse's smaller
  // PreviousActivity shape (which doesn't carry row/carrier) or any network
  // round trip — this works identically online or offline. The lookup +
  // display-label resolution ahead of commitLocalEvent is wrapped in the
  // same bounded timeout as the commit itself (withCommitTimeout), not
  // just the commit — both go through the local store on the web
  // platform and both are bounded by webEventJournal.ts internally, but
  // this keeps ONE outer bound around the whole action for consistency.
  const endBreakInternal = useCallback(
    async (clientEventId: string) => {
      setBusy(true);
      setError(null);
      logCheckpoint(clientEventId, "endBreak:tap-handler-entered");
      try {
        await withCommitTimeout(
          (async () => {
            const deviceId = getOrCreateDeviceIdentifier();
            const interrupted = await getLocalEventStore().getLatestWorkEventForDevice(deviceId);
            const display = await resolveDisplayLabels(
              interrupted?.activityId ?? null,
              interrupted?.greenhouseRowId ?? null,
              interrupted?.carrierId ?? null
            );
            await commitLocalEvent(
              "break_end",
              new Date().toISOString(),
              {
                activityId: interrupted?.activityId ?? null,
                greenhouseRowId: interrupted?.greenhouseRowId ?? null,
                carrierId: interrupted?.carrierId ?? null,
                // Carried over verbatim from the interrupted run's own event —
                // already a Record<string, QuestionAnswer> when it came from a
                // work_start/activity_switch, just typed generically on
                // LocalEvent (localEventStore.ts has no reason to know about
                // QuestionAnswer's shape).
                answers: (interrupted?.answers as Record<string, QuestionAnswer> | null | undefined) ?? null,
              },
              display,
              clientEventId
            );
          })()
        );
        setRetryAction(null);
      } catch (err) {
        if (err instanceof LocalCommitTimeoutError) {
          console.error("[work-session] break end timed out:", err);
          setError(t(language, "localCommitTimedOut"));
          setRetryAction(() => () => {
            void endBreakInternal(clientEventId);
          });
        } else {
          console.error("[work-session] break end failed:", err);
          setError(t(language, "somethingWentWrong"));
        }
      } finally {
        setBusy(false);
        logCheckpoint(clientEventId, "endBreak:busy-cleared");
      }
    },
    [commitLocalEvent, language]
  );

  const endBreak = useCallback(() => endBreakInternal(uuid()), [endBreakInternal]);

  const openEndDayConfirm = useCallback(() => {
    setEndDayError(null);
    setEndDayRetryAction(null);
    setEndDayConfirmOpen(true);
  }, []);

  const closeEndDayConfirm = useCallback(() => {
    if (endDaySubmitting) return; // block dismissal while a request is in flight
    setEndDayConfirmOpen(false);
    setEndDayError(null);
    setEndDayRetryAction(null);
  }, [endDaySubmitting]);

  // Local-first, same as every other action — the "Finish Work must be
  // online" restriction has been removed (confirmed decision: end-of-day is
  // now a normal queueable local event like everything else). The
  // confirmation DIALOG itself is unrelated UX (a deliberate "are you sure"
  // safety check) and stays regardless of connectivity. Uses its own
  // retry slot (endDayRetryAction), separate from the shared `retryAction`
  // the Home job picker/break buttons use — a timed-out end-day attempt's
  // Retry belongs in the confirm dialog it happened in, never surfaced on
  // an unrelated screen.
  const confirmEndDayInternal = useCallback(
    async (clientEventId: string) => {
      setEndDaySubmitting(true);
      setEndDayError(null);
      logCheckpoint(clientEventId, "confirmEndDay:tap-handler-entered");
      try {
        await commitLocalEvent("end_day", new Date().toISOString(), {}, {}, clientEventId);
        setEndDayRetryAction(null);
        setEndDayConfirmOpen(false);
      } catch (err) {
        if (err instanceof LocalCommitTimeoutError) {
          console.error("[work-session] end day timed out:", err);
          setEndDayError(t(language, "localCommitTimedOut"));
          setEndDayRetryAction(() => () => {
            void confirmEndDayInternal(clientEventId);
          });
        } else {
          console.error("[work-session] end day failed:", err);
          setEndDayError(t(language, "somethingWentWrong"));
        }
      } finally {
        setEndDaySubmitting(false);
        logCheckpoint(clientEventId, "confirmEndDay:busy-cleared");
      }
    },
    [commitLocalEvent, language]
  );

  const confirmEndDay = useCallback(() => confirmEndDayInternal(uuid()), [confirmEndDayInternal]);

  return (
    <WorkSessionContext.Provider
      value={{
        me,
        language,
        verified,
        busy,
        online,
        error,
        setError,
        retryAction,
        pending,
        syncProblem,
        pendingActivityName,
        pendingReassignment,
        acknowledgeReassignment,
        loadMe,
        handleApiError,
        perform,
        flush,
        startBreak,
        endBreak,
        endDayConfirmOpen,
        endDaySubmitting,
        endDayError,
        endDayRetryAction,
        openEndDayConfirm,
        closeEndDayConfirm,
        confirmEndDay,
      }}
    >
      {children}
    </WorkSessionContext.Provider>
  );
}

export function useWorkSession(): WorkSessionContextValue {
  const ctx = useContext(WorkSessionContext);
  if (!ctx) throw new Error("useWorkSession must be used within WorkSessionProvider");
  return ctx;
}
