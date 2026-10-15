package com.linklogictechnologies.labourlink.kiosk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.linklogictechnologies.labourlink.MainActivity;

/**
 * Kiosk phones only: brings LabourLink straight back after an app update
 * (MY_PACKAGE_REPLACED), which kills the running process and so ends lock
 * task mode. The EMM's kiosk launcher is the primary relaunch path; this is
 * the belt-and-braces one. Returns immediately on a personal phone.
 */
public class KioskRelaunchReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        if (!KioskController.isKioskDevice(context)) return;
        Log.i("LabourLinkKiosk", "updated — relaunching LabourLink");
        Intent launch = new Intent(context, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(launch);
        } catch (RuntimeException e) {
            Log.w("LabourLinkKiosk", "relaunch after update was refused; relying on the EMM kiosk launcher", e);
        }
    }
}
