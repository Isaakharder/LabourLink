package com.linklogictechnologies.labourlink.kiosk;

/**
 * Pure kiosk decision logic (no Android framework), unit-tested on the JVM.
 * KioskController feeds it the real RestrictionsManager / DevicePolicyManager
 * / SharedPreferences values.
 *
 * The single most important rule lives in isKioskDevice(): kiosk behaviour
 * exists ONLY when the device's management (the EMM acting as device owner)
 * has both (a) delivered the managed configuration kiosk_mode_enabled=true
 * to LabourLink and (b) allowlisted LabourLink for lock task. A personal
 * phone can never have either, there is no user-facing switch, and a
 * half-configured device (config delivered but lock task not allowlisted)
 * stays a normal app — calling startLockTask() on a non-allowlisted app
 * would show Android's screen-pinning prompt instead, which is explicitly
 * not what we want.
 */
public final class KioskPolicy {

    /** Length of a temporary maintenance exit. */
    public static final long MAINTENANCE_WINDOW_MS = 30L * 60L * 1000L;

    /** Failed PIN attempts allowed before lockout starts. */
    public static final int FREE_ATTEMPTS = 5;
    static final long FIRST_LOCKOUT_MS = 30_000L;
    static final long MAX_LOCKOUT_MS = 15L * 60L * 1000L;

    private KioskPolicy() {}

    public static boolean isKioskDevice(boolean managedKioskEnabled, boolean lockTaskPermitted) {
        return managedKioskEnabled && lockTaskPermitted;
    }

    /**
     * Whether a temporary maintenance exit is still in effect. A stored
     * deadline further in the future than one full window can only come
     * from a clock change, so it's treated as expired rather than trusted.
     */
    public static boolean isMaintenanceActive(long maintenanceUntilMs, long nowMs) {
        if (maintenanceUntilMs <= nowMs) return false;
        return maintenanceUntilMs - nowMs <= MAINTENANCE_WINDOW_MS;
    }

    /** Should the activity call startLockTask() right now? */
    public static boolean shouldEnterLockTask(boolean kioskDevice, boolean alreadyLocked, long maintenanceUntilMs, long nowMs) {
        return kioskDevice && !alreadyLocked && !isMaintenanceActive(maintenanceUntilMs, nowMs);
    }

    /**
     * Lockout after FREE_ATTEMPTS consecutive failures: 30s, doubling per
     * further failure, capped at 15 minutes. Returns the epoch-ms until
     * which attempts are refused (0 = not locked).
     */
    public static long lockoutUntil(int consecutiveFailures, long lastFailureAtMs) {
        if (consecutiveFailures < FREE_ATTEMPTS) return 0;
        int extra = Math.min(consecutiveFailures - FREE_ATTEMPTS, 10);
        long delay = Math.min(FIRST_LOCKOUT_MS << extra, MAX_LOCKOUT_MS);
        return lastFailureAtMs + delay;
    }

    public static boolean isLockedOut(int consecutiveFailures, long lastFailureAtMs, long nowMs) {
        // A last-failure timestamp in the future (clock moved back) is
        // clamped to now, so it can never mean more than one MAX_LOCKOUT_MS
        // wait; KioskController also rewrites the stored value to now so
        // that wait actually elapses.
        long until = lockoutUntil(consecutiveFailures, Math.min(lastFailureAtMs, nowMs));
        return nowMs < until;
    }

    /**
     * Which encoded credential is in force. A locally rotated credential
     * wins only while the managed credential it replaced is still the one
     * the EMM is delivering — so changing maintenance_credential in the EMM
     * console always overrides a forgotten local one (the recovery path).
     */
    public static String effectiveCredential(String managedCredential, String localCredential, String localBaseManagedCredential) {
        String managed = emptyToNull(managedCredential);
        String local = emptyToNull(localCredential);
        if (local != null && equalsNullable(managed, emptyToNull(localBaseManagedCredential))) return local;
        return managed;
    }

    private static String emptyToNull(String s) {
        return s == null || s.trim().isEmpty() ? null : s.trim();
    }

    private static boolean equalsNullable(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }
}
