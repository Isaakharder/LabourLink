package com.linklogictechnologies.labourlink.kiosk;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.RestrictionsManager;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

/**
 * Android wiring for KioskPolicy: reads the EMM-delivered managed
 * configuration, the device owner's lock task allowlist and this app's own
 * private kiosk state, and enters/leaves Android Lock Task Mode.
 *
 * Every entry point is a no-op unless KioskPolicy.isKioskDevice() is true,
 * which on a personal phone it never is (no managed configuration, no lock
 * task allowlist) — that's what keeps regular Android behaviour unchanged.
 *
 * Kiosk state lives in its own SharedPreferences file, never in the
 * WebView's storage, so it can't interfere with device identity, pairing or
 * the pending-event SQLite database, and allowBackup=false keeps it off
 * every backup path exactly like those.
 */
public final class KioskController {

    private static final String TAG = "LabourLinkKiosk";

    // Managed configuration keys — must match res/xml/app_restrictions.xml.
    public static final String KEY_KIOSK_ENABLED = "kiosk_mode_enabled";
    public static final String KEY_CREDENTIAL = "maintenance_credential";
    public static final String KEY_DEVICE_LABEL = "kiosk_device_label";

    private static final String PREFS = "labourlink_kiosk";
    private static final String PREF_MAINTENANCE_UNTIL = "maintenance_until";
    private static final String PREF_LOCAL_CREDENTIAL = "local_credential";
    private static final String PREF_LOCAL_BASE = "local_credential_base";
    private static final String PREF_FAILURES = "pin_failures";
    private static final String PREF_LAST_FAILURE = "pin_last_failure";
    private static final String PREF_LAST_DEVICE_ID = "last_device_identifier";
    private static final String PREF_LAST_PENDING = "last_pending_count";
    private static final String PREF_LAST_SYNC = "last_successful_sync";
    private static final String PREF_LAST_EMPLOYEE = "last_employee";
    private static final String PREF_LAST_REPORTED_AT = "last_reported_at";

    private KioskController() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static Bundle managedConfig(Context ctx) {
        RestrictionsManager rm = (RestrictionsManager) ctx.getSystemService(Context.RESTRICTIONS_SERVICE);
        if (rm == null) return new Bundle();
        Bundle b = rm.getApplicationRestrictions();
        return b != null ? b : new Bundle();
    }

    static boolean isLockTaskPermitted(Context ctx) {
        DevicePolicyManager dpm = (DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE);
        return dpm != null && dpm.isLockTaskPermitted(ctx.getPackageName());
    }

    public static boolean isKioskDevice(Context ctx) {
        return KioskPolicy.isKioskDevice(managedConfig(ctx).getBoolean(KEY_KIOSK_ENABLED, false), isLockTaskPermitted(ctx));
    }

    /** ActivityManager.LOCK_TASK_MODE_NONE / LOCKED / PINNED. */
    public static int lockTaskModeState(Context ctx) {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        return am != null ? am.getLockTaskModeState() : ActivityManager.LOCK_TASK_MODE_NONE;
    }

    public static boolean isLocked(Context ctx) {
        return lockTaskModeState(ctx) == ActivityManager.LOCK_TASK_MODE_LOCKED;
    }

    public static long maintenanceUntil(Context ctx) {
        return prefs(ctx).getLong(PREF_MAINTENANCE_UNTIL, 0L);
    }

    public static boolean isMaintenanceActive(Context ctx) {
        return KioskPolicy.isMaintenanceActive(maintenanceUntil(ctx), System.currentTimeMillis());
    }

    /**
     * Called from MainActivity.onResume() and on managed-config changes.
     * Enters true Lock Task Mode when this is an enrolled kiosk device and
     * no maintenance exit is active. Returns whether kiosk is (now) locked.
     */
    public static boolean enforce(Activity activity) {
        boolean kiosk = isKioskDevice(activity);
        if (!kiosk) return false;
        boolean locked = isLocked(activity);
        if (KioskPolicy.shouldEnterLockTask(kiosk, locked, maintenanceUntil(activity), System.currentTimeMillis())) {
            try {
                activity.startLockTask();
                Log.i(TAG, "entered lock task mode");
                return true;
            } catch (RuntimeException e) {
                // Only thrown if the allowlist changed between the check and
                // the call — stay a normal app rather than crash-looping.
                Log.e(TAG, "startLockTask failed", e);
                return false;
            }
        }
        return locked;
    }

    /** Temporary maintenance exit (admin-authenticated by MaintenanceActivity). */
    public static void beginMaintenance(Activity activity) {
        beginMaintenance(activity, KioskPolicy.MAINTENANCE_WINDOW_MS);
    }

    /** Same, for a shorter window (e.g. just long enough to change Wi-Fi). */
    public static void beginMaintenance(Activity activity, long durationMs) {
        long window = Math.min(durationMs, KioskPolicy.MAINTENANCE_WINDOW_MS);
        prefs(activity).edit().putLong(PREF_MAINTENANCE_UNTIL, System.currentTimeMillis() + window).commit();
        if (isLocked(activity)) {
            try {
                activity.stopLockTask();
                Log.i(TAG, "left lock task mode for maintenance");
            } catch (RuntimeException e) {
                Log.e(TAG, "stopLockTask failed", e);
            }
        }
    }

    /** Ends a maintenance exit; the next enforce() re-locks. */
    public static void endMaintenance(Context ctx) {
        prefs(ctx).edit().remove(PREF_MAINTENANCE_UNTIL).commit();
    }

    // ---- maintenance credential ------------------------------------------

    public static String managedCredential(Context ctx) {
        return managedConfig(ctx).getString(KEY_CREDENTIAL, null);
    }

    public static String effectiveCredential(Context ctx) {
        SharedPreferences p = prefs(ctx);
        String effective = KioskPolicy.effectiveCredential(
            managedCredential(ctx),
            p.getString(PREF_LOCAL_CREDENTIAL, null),
            p.getString(PREF_LOCAL_BASE, null)
        );
        return effective != null && KioskCredential.isWellFormed(effective) ? effective : null;
    }

    public static boolean hasUsableCredential(Context ctx) {
        return effectiveCredential(ctx) != null;
    }

    // A last-failure time in the future means the clock moved back since
    // it was stored. Rewrite it to "now" once, so the lockout then runs out
    // normally instead of restarting on every check while the clock lags.
    private static long lastFailureAt(SharedPreferences p, long now) {
        long last = p.getLong(PREF_LAST_FAILURE, 0L);
        if (last > now) {
            p.edit().putLong(PREF_LAST_FAILURE, now).commit();
            return now;
        }
        return last;
    }

    public static boolean isLockedOut(Context ctx) {
        SharedPreferences p = prefs(ctx);
        long now = System.currentTimeMillis();
        return KioskPolicy.isLockedOut(p.getInt(PREF_FAILURES, 0), lastFailureAt(p, now), now);
    }

    public static long lockoutRemainingMs(Context ctx) {
        SharedPreferences p = prefs(ctx);
        long now = System.currentTimeMillis();
        long until = KioskPolicy.lockoutUntil(p.getInt(PREF_FAILURES, 0), lastFailureAt(p, now));
        return Math.max(0L, until - now);
    }

    /** Slow (PBKDF2) — call off the main thread. Records failures for lockout. */
    public static boolean verifyPin(Context ctx, String pin) {
        if (isLockedOut(ctx)) return false;
        String credential = effectiveCredential(ctx);
        boolean ok = credential != null && KioskCredential.verify(pin, credential);
        SharedPreferences p = prefs(ctx);
        if (ok) {
            p.edit().remove(PREF_FAILURES).remove(PREF_LAST_FAILURE).commit();
        } else {
            p.edit().putInt(PREF_FAILURES, p.getInt(PREF_FAILURES, 0) + 1).putLong(PREF_LAST_FAILURE, System.currentTimeMillis()).commit();
        }
        return ok;
    }

    /** Slow (PBKDF2) — call off the main thread. Caller has already authenticated. */
    public static void setLocalPin(Context ctx, String newPin) {
        String encoded = KioskCredential.create(newPin);
        String base = managedCredential(ctx);
        prefs(ctx).edit().putString(PREF_LOCAL_CREDENTIAL, encoded).putString(PREF_LOCAL_BASE, base != null ? base.trim() : null).commit();
    }

    // ---- last-known app status (for the maintenance screen) --------------

    /** Stored whenever the web app reports it, so maintenance can show it even if the WebView later fails. */
    public static void rememberStatus(Context ctx, String deviceId, int pendingCount, String lastSyncAt, String employee) {
        prefs(ctx)
            .edit()
            .putString(PREF_LAST_DEVICE_ID, deviceId)
            .putInt(PREF_LAST_PENDING, pendingCount)
            .putString(PREF_LAST_SYNC, lastSyncAt)
            .putString(PREF_LAST_EMPLOYEE, employee)
            .putLong(PREF_LAST_REPORTED_AT, System.currentTimeMillis())
            .apply();
    }

    public static final class LastStatus {
        public String deviceId;
        public int pendingCount = -1;
        public String lastSyncAt;
        public String employee;
        public long reportedAt;
    }

    public static LastStatus lastStatus(Context ctx) {
        SharedPreferences p = prefs(ctx);
        LastStatus s = new LastStatus();
        s.deviceId = p.getString(PREF_LAST_DEVICE_ID, null);
        s.pendingCount = p.getInt(PREF_LAST_PENDING, -1);
        s.lastSyncAt = p.getString(PREF_LAST_SYNC, null);
        s.employee = p.getString(PREF_LAST_EMPLOYEE, null);
        s.reportedAt = p.getLong(PREF_LAST_REPORTED_AT, 0L);
        return s;
    }

    public static String deviceLabel(Context ctx) {
        return managedConfig(ctx).getString(KEY_DEVICE_LABEL, null);
    }

    public static String describeLockState(Context ctx) {
        switch (lockTaskModeState(ctx)) {
            case ActivityManager.LOCK_TASK_MODE_LOCKED:
                return "Locked (lock task mode)";
            case ActivityManager.LOCK_TASK_MODE_PINNED:
                return "Screen pinned (not kiosk)";
            default:
                return isMaintenanceActive(ctx) ? "Maintenance exit active" : "Not locked";
        }
    }

    static boolean supportsHideOverlays() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
    }
}
