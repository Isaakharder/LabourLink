package com.linklogictechnologies.labourlink;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;

/**
 * Plain-JVM unit coverage for ColdStartWatchdog's decision logic — the fix
 * for the 2026-09-14 Nattawat N incident (4 Activity recreations during one
 * slow cold start, each destroying real in-flight WebView/JS progress). No
 * Android framework, no emulator: FakeScheduler stands in for the real
 * Handler and lets each test fire the scheduled timeout deterministically
 * instead of racing a real clock.
 */
public class ColdStartWatchdogTest {

    /** Deterministic stand-in for the real Handler-backed Scheduler. */
    static final class FakeScheduler implements ColdStartWatchdog.Scheduler {
        Runnable scheduledAction;
        long scheduledDelayMs = -1;
        boolean cancelled;

        @Override
        public ColdStartWatchdog.Cancellable schedule(long delayMs, Runnable action) {
            scheduledAction = action;
            scheduledDelayMs = delayMs;
            cancelled = false;
            return () -> cancelled = true;
        }

        /** Simulates the scheduled delay actually elapsing. */
        void fire() {
            if (!cancelled && scheduledAction != null) {
                scheduledAction.run();
            }
        }
    }

    static final class FakeActions implements ColdStartWatchdog.Actions {
        int recreateCalls = 0;
        int fallbackCalls = 0;

        @Override
        public void recreateActivity() {
            recreateCalls++;
        }

        @Override
        public void showManualFallback() {
            fallbackCalls++;
        }
    }

    private FakeScheduler scheduler;
    private FakeActions actions;
    private ColdStartWatchdog.Session session;

    @Before
    public void setUp() {
        scheduler = new FakeScheduler();
        actions = new FakeActions();
        session = new ColdStartWatchdog.Session();
    }

    private ColdStartWatchdog newWatchdog() {
        return new ColdStartWatchdog(session, scheduler, actions, 8000);
    }

    // ---------------------------------------------------------------------
    // Slow startup
    // ---------------------------------------------------------------------

    @Test
    public void slowStartup_timesOutWithNoSuccess_triggersExactlyOneRecreate() {
        ColdStartWatchdog watchdog = newWatchdog();
        watchdog.start();

        scheduler.fire(); // the 8s timeout elapses with no markReady()

        assertEquals("exactly one recreate, never a repeating loop", 1, actions.recreateCalls);
        assertEquals(0, actions.fallbackCalls);
        assertTrue("the session now remembers a recovery was used", session.recoveryAttempted);
    }

    // ---------------------------------------------------------------------
    // Successful startup just before timeout
    // ---------------------------------------------------------------------

    @Test
    public void successJustBeforeTimeout_cancelsTheScheduledCheck_noRecreateNoFallback() {
        ColdStartWatchdog watchdog = newWatchdog();
        watchdog.start();

        watchdog.markReady(); // the page reports ready an instant before the timeout would have fired
        scheduler.fire(); // the already-cancelled callback must be a no-op even if "fired" anyway

        assertEquals(0, actions.recreateCalls);
        assertEquals(0, actions.fallbackCalls);
        assertTrue("the FakeScheduler's cancellable was actually invoked", scheduler.cancelled);
    }

    @Test
    public void success_resetsTheSessionForTheNextColdStart() {
        session.recoveryAttempted = true; // as if a prior attempt this same process already recovered once
        ColdStartWatchdog watchdog = newWatchdog();
        watchdog.start();

        watchdog.markReady();

        assertFalse("a real success clears the flag — the next cold start gets its own fresh budget", session.recoveryAttempted);
    }

    // ---------------------------------------------------------------------
    // Activity recreation: the SECOND instance (sharing the same Session)
    // must go straight to fallback on its own timeout, never a second
    // recreate — this is the direct fix for "recreated 4 times."
    // ---------------------------------------------------------------------

    @Test
    public void activityRecreation_secondInstanceTimeoutShowsFallback_neverASecondRecreate() {
        // First instance: times out, recreates once.
        ColdStartWatchdog first = newWatchdog();
        first.start();
        scheduler.fire();
        assertEquals(1, actions.recreateCalls);

        // recreate() tears down the first instance (onDestroy -> cancel())
        // and a second instance is constructed, sharing the SAME session —
        // exactly as MainActivity's static watchdogSession does.
        first.cancel();
        ColdStartWatchdog second = newWatchdog();
        second.start();
        scheduler.fire(); // the second instance's own timeout also elapses with no success

        assertEquals("never a second recreate", 1, actions.recreateCalls);
        assertEquals("the second miss goes straight to the fallback", 1, actions.fallbackCalls);
    }

    @Test
    public void activityRecreation_thirdInstanceWouldAlsoOnlyEverShowFallback() {
        ColdStartWatchdog first = newWatchdog();
        first.start();
        scheduler.fire();
        first.cancel();

        ColdStartWatchdog second = newWatchdog();
        second.start();
        scheduler.fire();
        second.cancel();

        // Hypothetically a THIRD instance (should never happen under the new
        // policy, since the fallback UI replaces the WebView instead of
        // scheduling anything further — but proves the policy is durable
        // even if something re-armed a watchdog on the same session).
        ColdStartWatchdog third = newWatchdog();
        third.start();
        scheduler.fire();

        assertEquals(1, actions.recreateCalls);
        assertEquals("still only ever the fallback, never another recreate", 2, actions.fallbackCalls);
    }

    // ---------------------------------------------------------------------
    // Process restart: a brand-new Session (a genuinely new OS process)
    // behaves like a fresh cold start even though a PRIOR process's session
    // had already used its recovery attempt.
    // ---------------------------------------------------------------------

    @Test
    public void processRestart_freshSessionGetsItsOwnRecoveryAttempt() {
        ColdStartWatchdog.Session exhaustedSession = new ColdStartWatchdog.Session();
        exhaustedSession.recoveryAttempted = true; // the previous process had already used its one recovery

        ColdStartWatchdog.Session freshSession = new ColdStartWatchdog.Session(); // a real new process's own static field
        ColdStartWatchdog watchdog = new ColdStartWatchdog(freshSession, scheduler, actions, 8000);
        watchdog.start();
        scheduler.fire();

        assertEquals("a fresh process's session is unaffected by the old one", 1, actions.recreateCalls);
        assertEquals(0, actions.fallbackCalls);
    }

    // ---------------------------------------------------------------------
    // Repeated watchdog callbacks: single-flight guarantee — the exact
    // scheduled callback firing more than once (a duplicate Handler
    // message, or markReady()/cancel() racing the timeout) never produces
    // more than one action.
    // ---------------------------------------------------------------------

    @Test
    public void repeatedCallbackFires_onlyActsOnce() {
        ColdStartWatchdog watchdog = newWatchdog();
        watchdog.start();

        scheduler.fire();
        scheduler.fire(); // the same underlying Runnable invoked again
        scheduler.fire();

        assertEquals("single-flight: only the first firing ever acts", 1, actions.recreateCalls);
        assertEquals(0, actions.fallbackCalls);
    }

    @Test
    public void markReadyAfterTimeoutAlreadyFired_isANoOp() {
        ColdStartWatchdog watchdog = newWatchdog();
        watchdog.start();
        scheduler.fire(); // already settled as "recreate"

        watchdog.markReady(); // arrives late — must not un-do or double-count anything

        assertEquals(1, actions.recreateCalls);
        assertFalse(
            "settled-by-timeout must NOT be overwritten by a late markReady() into looking like a fresh success",
            session.recoveryAttempted == false
        );
    }

    @Test
    public void cancelAfterMarkReady_isANoOp() {
        ColdStartWatchdog watchdog = newWatchdog();
        watchdog.start();
        watchdog.markReady();

        watchdog.cancel(); // onDestroy() arriving after a successful start — must not throw or double-act

        assertEquals(0, actions.recreateCalls);
        assertEquals(0, actions.fallbackCalls);
    }

    // ---------------------------------------------------------------------
    // Never overlapping: two DIFFERENT ColdStartWatchdog instances built
    // against the SAME session must never both decide to recreate — the
    // exact "overlapping recreation loops" this fix closes.
    // ---------------------------------------------------------------------

    @Test
    public void twoInstancesSameSession_neverBothRecreate_evenIfBothTimeOutBeforeEitherIsCancelled() {
        FakeScheduler schedulerA = new FakeScheduler();
        FakeScheduler schedulerB = new FakeScheduler();
        ColdStartWatchdog a = new ColdStartWatchdog(session, schedulerA, actions, 8000);
        ColdStartWatchdog b = new ColdStartWatchdog(session, schedulerB, actions, 8000);
        a.start();
        b.start(); // simulates a stray second instance existing concurrently, never cancelled first

        schedulerA.fire();
        schedulerB.fire();

        assertEquals("the shared session's recoveryAttempted flag makes the second one fall back, not recreate again", 1, actions.recreateCalls);
        assertEquals(1, actions.fallbackCalls);
    }
}
