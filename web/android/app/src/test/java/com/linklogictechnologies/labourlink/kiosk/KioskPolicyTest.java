package com.linklogictechnologies.labourlink.kiosk;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class KioskPolicyTest {

    private static final long NOW = 1_800_000_000_000L;

    @Test
    public void personalPhoneIsNeverAKioskDevice() {
        assertFalse(KioskPolicy.isKioskDevice(false, false));
        // Managed config delivered but not allowlisted for lock task would
        // mean screen pinning, not kiosk — must stay a normal app.
        assertFalse(KioskPolicy.isKioskDevice(true, false));
        // Allowlisted by some other DPC policy but kiosk not switched on.
        assertFalse(KioskPolicy.isKioskDevice(false, true));
        assertTrue(KioskPolicy.isKioskDevice(true, true));
    }

    @Test
    public void entersLockTaskOnlyWhenKioskUnlockedAndNoMaintenance() {
        assertTrue(KioskPolicy.shouldEnterLockTask(true, false, 0, NOW));
        assertFalse(KioskPolicy.shouldEnterLockTask(false, false, 0, NOW));
        assertFalse(KioskPolicy.shouldEnterLockTask(true, true, 0, NOW));
        assertFalse(KioskPolicy.shouldEnterLockTask(true, false, NOW + 60_000, NOW));
        assertTrue(KioskPolicy.shouldEnterLockTask(true, false, NOW - 1, NOW));
    }

    @Test
    public void maintenanceDeadlineFromAClockChangeIsNotTrusted() {
        assertTrue(KioskPolicy.isMaintenanceActive(NOW + KioskPolicy.MAINTENANCE_WINDOW_MS, NOW));
        assertFalse(KioskPolicy.isMaintenanceActive(NOW + KioskPolicy.MAINTENANCE_WINDOW_MS + 1, NOW));
        assertFalse(KioskPolicy.isMaintenanceActive(0, NOW));
    }

    @Test
    public void lockoutBacksOffAndCaps() {
        assertFalse(KioskPolicy.isLockedOut(4, NOW, NOW));
        assertTrue(KioskPolicy.isLockedOut(5, NOW, NOW + 29_999));
        assertFalse(KioskPolicy.isLockedOut(5, NOW, NOW + 30_000));
        assertEquals(NOW + 60_000, KioskPolicy.lockoutUntil(6, NOW));
        assertEquals(NOW + 15 * 60_000, KioskPolicy.lockoutUntil(50, NOW));
    }

    @Test
    public void clockMovedBackCannotLockOutForever() {
        long farFuture = NOW + 365L * 24 * 3600 * 1000;
        // Clamped to now: at most one maximum-length wait, not a year.
        assertTrue(KioskPolicy.isLockedOut(50, farFuture, NOW));
        assertEquals(NOW + 15 * 60_000, KioskPolicy.lockoutUntil(50, Math.min(farFuture, NOW)));
        // Once KioskController has rewritten the stored time to NOW, it expires.
        assertFalse(KioskPolicy.isLockedOut(50, NOW, NOW + 15 * 60_000));
    }

    @Test
    public void localCredentialWinsOnlyUntilTheConsoleRotatesIt() {
        assertEquals("managedA", KioskPolicy.effectiveCredential("managedA", null, null));
        assertEquals("local", KioskPolicy.effectiveCredential("managedA", "local", "managedA"));
        // Admin forgot the local PIN and set a new one in the EMM console.
        assertEquals("managedB", KioskPolicy.effectiveCredential("managedB", "local", "managedA"));
        // Local PIN set before any managed credential existed.
        assertEquals("local", KioskPolicy.effectiveCredential(null, "local", null));
        assertEquals("managedB", KioskPolicy.effectiveCredential("managedB", "local", null));
        assertNull(KioskPolicy.effectiveCredential(null, null, null));
        assertNull(KioskPolicy.effectiveCredential("  ", "", null));
    }
}
