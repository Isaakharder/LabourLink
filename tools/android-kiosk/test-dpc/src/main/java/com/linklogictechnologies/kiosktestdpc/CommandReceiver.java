package com.linklogictechnologies.kiosktestdpc;

import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.os.UserManager;
import android.util.Log;

/**
 * TEST ONLY. Applies, via adb broadcasts, the same device-owner policy the
 * real EMM kiosk policy applies (see tools/android-kiosk/README.md for the
 * one-to-one mapping), so the emulator suite exercises LabourLink under
 * real Lock Task Mode.
 *
 *   APPLY_KIOSK   --es credential <pbkdf2...> [--es label <s>] [--ez launch_locked true]
 *   SET_CONFIG    [--ez kiosk true|false] [--es credential <s>] [--es label <s>]
 *   CLEAR_KIOSK   undo everything APPLY_KIOSK did
 *   REMOVE_OWNER  clearDeviceOwnerApp (run CLEAR_KIOSK first)
 *   HIDE_PACKAGE  --es package <pkg>   setApplicationHidden(true) — reversible
 *   UNHIDE_PACKAGE --es package <pkg>  setApplicationHidden(false)
 *
 * HIDE_PACKAGE is the device-owner equivalent of an EMM "disable system
 * app" policy, e.g. for the Ulefone/PRIZE com.pri.morning.kill service that
 * force-stops apps nightly. The package stays installed with its data; it
 * just can't run until unhidden. Persists across reboots.
 */
public class CommandReceiver extends BroadcastReceiver {

    static final String LABOURLINK = "com.linklogictechnologies.labourlink";
    private static final String P = "com.linklogictechnologies.kiosktestdpc.";

    private static final String[] RESTRICTIONS = {
        UserManager.DISALLOW_SAFE_BOOT,
        UserManager.DISALLOW_FACTORY_RESET,
        UserManager.DISALLOW_ADD_USER,
        UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY,
        UserManager.DISALLOW_CREATE_WINDOWS,
        UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS,
    };

    @Override
    public void onReceive(Context ctx, Intent intent) {
        DevicePolicyManager dpm = (DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE);
        ComponentName admin = new ComponentName(ctx, AdminReceiver.class);
        String action = intent.getAction() == null ? "" : intent.getAction().replace(P, "");
        if (!dpm.isDeviceOwnerApp(ctx.getPackageName())) {
            Log.e(KioskHomeActivity.TAG, "not device owner — ignoring " + action);
            setResultData("ERROR not device owner");
            return;
        }
        try {
            switch (action) {
                case "APPLY_KIOSK": {
                    dpm.setLockTaskPackages(admin, new String[] { LABOURLINK });
                    // Power/restart menu only: no Home, Recents, notifications, system info, keyguard.
                    dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS);
                    dpm.setStatusBarDisabled(admin, true);
                    dpm.setKeyguardDisabled(admin, true);
                    for (String r : RESTRICTIONS) dpm.addUserRestriction(admin, r);
                    if (Build.VERSION.SDK_INT >= 33) {
                        dpm.setPermissionGrantState(admin, LABOURLINK, "android.permission.POST_NOTIFICATIONS", DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
                    }
                    Bundle config = new Bundle();
                    config.putBoolean("kiosk_mode_enabled", true);
                    putIfPresent(config, "maintenance_credential", intent.getStringExtra("credential"));
                    putIfPresent(config, "kiosk_device_label", intent.getStringExtra("label"));
                    dpm.setApplicationRestrictions(admin, LABOURLINK, config);
                    ctx.getSharedPreferences("dpc", Context.MODE_PRIVATE).edit().putBoolean("launch_locked", intent.getBooleanExtra("launch_locked", false)).commit();
                    IntentFilter home = new IntentFilter(Intent.ACTION_MAIN);
                    home.addCategory(Intent.CATEGORY_HOME);
                    home.addCategory(Intent.CATEGORY_DEFAULT);
                    dpm.addPersistentPreferredActivity(admin, home, new ComponentName(ctx, KioskHomeActivity.class));
                    break;
                }
                case "SET_CONFIG": {
                    Bundle config = dpm.getApplicationRestrictions(admin, LABOURLINK);
                    if (intent.hasExtra("kiosk")) config.putBoolean("kiosk_mode_enabled", intent.getBooleanExtra("kiosk", false));
                    if (intent.hasExtra("credential")) config.putString("maintenance_credential", intent.getStringExtra("credential"));
                    if (intent.hasExtra("label")) config.putString("kiosk_device_label", intent.getStringExtra("label"));
                    dpm.setApplicationRestrictions(admin, LABOURLINK, config);
                    break;
                }
                case "CLEAR_KIOSK": {
                    dpm.clearPackagePersistentPreferredActivities(admin, ctx.getPackageName());
                    dpm.setApplicationRestrictions(admin, LABOURLINK, new Bundle());
                    dpm.setLockTaskPackages(admin, new String[0]);
                    dpm.setStatusBarDisabled(admin, false);
                    dpm.setKeyguardDisabled(admin, false);
                    for (String r : RESTRICTIONS) dpm.clearUserRestriction(admin, r);
                    break;
                }
                case "HIDE_PACKAGE":
                case "UNHIDE_PACKAGE": {
                    String pkg = intent.getStringExtra("package");
                    if (pkg == null || pkg.isEmpty()) {
                        setResultData("ERROR package required");
                        return;
                    }
                    boolean hide = action.equals("HIDE_PACKAGE");
                    boolean changed = dpm.setApplicationHidden(admin, pkg, hide);
                    boolean now = dpm.isApplicationHidden(admin, pkg);
                    Log.i(KioskHomeActivity.TAG, action + " " + pkg + " changed=" + changed + " hidden=" + now);
                    setResultData("OK " + action + " " + pkg + " hidden=" + now);
                    return;
                }
                case "REMOVE_OWNER":
                    dpm.clearDeviceOwnerApp(ctx.getPackageName());
                    break;
                default:
                    setResultData("ERROR unknown action " + action);
                    return;
            }
            Log.i(KioskHomeActivity.TAG, action + " ok");
            setResultData("OK " + action);
        } catch (RuntimeException e) {
            Log.e(KioskHomeActivity.TAG, action + " failed", e);
            setResultData("ERROR " + e);
        }
    }

    private static void putIfPresent(Bundle b, String key, String value) {
        if (value != null) b.putString(key, value);
    }
}
