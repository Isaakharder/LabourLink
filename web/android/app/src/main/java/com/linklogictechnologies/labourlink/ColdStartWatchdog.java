package com.linklogictechnologies.labourlink;

/**
 * Pure, Android-framework-free decision logic for the cold-start watchdog —
 * kept free of android.os.Handler/Looper/Activity so it can be unit-tested
 * with plain JUnit on the JVM (no emulator, no Robolectric). MainActivity
 * wires this to the real Handler/recreate()/fallback UI via the Scheduler
 * and Actions interfaces below.
 *
 * Background: MainActivity's original watchdog retried up to 20 times with
 * linearly increasing backoff (5s, 7s, 9s, ...) whenever the WebView hadn't
 * fired onPageStarted yet, recreating the Activity on every miss. That
 * policy was built for a confirmed device/WebView-level defect where the
 * sandboxed renderer process fails to spawn at all and Android marks the
 * process "bad" for a cooldown window — see the surrounding comment this
 * class's own history replaces for the full investigation.
 *
 * Incident (2026-09-14, Nattawat N, physical device logcat): on a slow,
 * thermally-throttled cold start, the watchdog recreated the Activity FOUR
 * times in under 20 seconds — 5004ms, then 7006ms, 9002ms, 11001ms after
 * each successive onCreate — while the WebView was actually loading and
 * running real app JS (confirmed: CapacitorNfcPlugin and CapacitorSQLite
 * activity visible in the same window), not dead. Each recreate() tears
 * down an in-flight Bridge/WebView/JS context, discarding real progress and
 * adding more CPU/memory churn on an already-struggling device — a
 * plausible trigger for the overlapping local-event-store writes behind
 * that incident's "UNIQUE constraint failed: pending_events.device_id,
 * pending_events.device_seq" bug (see localEventStore.ts /
 * localSequenceAssignment.ts).
 *
 * New policy: at most ONE automatic recovery attempt (one recreate()) per
 * cold-start session, then the native fallback screen — never a repeating
 * loop, and never more than two total activity instances for one cold
 * start.
 */
public final class ColdStartWatchdog {

    /** How long to wait for the page to report ready before acting. */
    public static final long TIMEOUT_MS = 8000;

    /** Schedules a delayed action and returns a handle to cancel it. */
    public interface Scheduler {
        Cancellable schedule(long delayMs, Runnable action);
    }

    public interface Cancellable {
        void cancel();
    }

    /** The two possible outcomes when the timeout fires with no success. */
    public interface Actions {
        void recreateActivity();
        void showManualFallback();
    }

    /**
     * Cross-recreate() state for one cold-start session. A genuinely new
     * cold start is a new OS process, so a fresh Session naturally starts
     * with recoveryAttempted=false — same "survives recreate() within one
     * process, resets on a real new process" reasoning the original
     * implementation's static retryCount used, just made explicit and
     * injectable (a real Java static in MainActivity for production; a
     * fresh instance per test, so tests never leak state into each other).
     */
    public static final class Session {
        volatile boolean recoveryAttempted = false;
    }

    private final Session session;
    private final Scheduler scheduler;
    private final Actions actions;
    private final long timeoutMs;

    private boolean pageStarted = false;
    // True once this attempt's outcome has been decided (settled by
    // markReady(), cancel(), or the timeout firing) — every one of those
    // three entry points checks and immediately sets this, so no matter how
    // many times any of them is invoked (a duplicate Handler message, a
    // stray onPageLoaded after onPageStarted already fired, the timeout
    // racing a last-instant success), at most ONE action is ever taken by
    // THIS instance. This is the single-flight guarantee.
    private boolean settled = false;
    private Cancellable pending;

    public ColdStartWatchdog(Session session, Scheduler scheduler, Actions actions) {
        this(session, scheduler, actions, TIMEOUT_MS);
    }

    /** Package-private timeout override — test-only; production always uses TIMEOUT_MS. */
    ColdStartWatchdog(Session session, Scheduler scheduler, Actions actions, long timeoutMs) {
        this.session = session;
        this.scheduler = scheduler;
        this.actions = actions;
        this.timeoutMs = timeoutMs;
    }

    /** Call once, from onCreate(). Arms exactly one scheduled check. */
    public void start() {
        pending = scheduler.schedule(timeoutMs, this::onTimeout);
    }

    /**
     * Call from onPageStarted/onPageLoaded. Cancels the scheduled check
     * immediately — a real success always wins over a not-yet-fired
     * timeout, however close together they land — and, since this cold
     * start ended in success, resets the shared session so the NEXT cold
     * start gets its own fresh one-recovery budget rather than inheriting
     * this one's.
     */
    public void markReady() {
        if (settled) return;
        settled = true;
        pageStarted = true;
        if (pending != null) pending.cancel();
        session.recoveryAttempted = false;
    }

    /**
     * Call from onDestroy(). Lifecycle-aware: an instance being torn down
     * (for its own recreate(), or the user leaving mid-start) can never
     * have its scheduled check act afterward — settled=true here makes
     * onTimeout() a guaranteed no-op even if it was already queued to run.
     */
    public void cancel() {
        if (settled) return;
        settled = true;
        if (pending != null) pending.cancel();
    }

    private void onTimeout() {
        if (settled) return;
        settled = true;
        if (pageStarted) return; // belt-and-braces; markReady() already short-circuits via `settled`

        if (!session.recoveryAttempted) {
            session.recoveryAttempted = true;
            actions.recreateActivity();
        } else {
            actions.showManualFallback();
        }
    }
}
