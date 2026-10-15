package com.linklogictechnologies.labourlink.kiosk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS bridge for kiosk mode (web/src/lib/kiosk.ts). Everything here is inert
 * unless KioskController.isKioskDevice() — on a personal phone getStatus()
 * reports kioskDevice=false, shouldOverrideLoad() defers to Capacitor's
 * normal policy, and the maintenance/alert methods refuse.
 */
@CapacitorPlugin(name = "LabourLinkKiosk")
public class KioskPlugin extends Plugin {

    private static final String TAG = "LabourLinkKiosk";

    private BroadcastReceiver configReceiver;

    // The EMM can deliver (or change, or remove) the kiosk managed config
    // while LabourLink is already running — typically right after the
    // first launch on a freshly enrolled phone. The web app caches its
    // kiosk status, so tell it to re-read instead of staying on a stale
    // "not a kiosk device" until the next restart.
    @Override
    public void load() {
        configReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                notifyListeners("statusChanged", status());
            }
        };
        IntentFilter filter = new IntentFilter(Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(configReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(configReceiver, filter);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (configReceiver != null) {
            getContext().unregisterReceiver(configReceiver);
            configReceiver = null;
        }
    }

    private JSObject status() {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        ret.put("kioskDevice", KioskController.isKioskDevice(ctx));
        ret.put("locked", KioskController.isLocked(ctx));
        ret.put("maintenanceActive", KioskController.isMaintenanceActive(ctx));
        return ret;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void reportStatus(PluginCall call) {
        if (!KioskController.isKioskDevice(getContext())) {
            call.resolve();
            return;
        }
        remember(call);
        call.resolve();
    }

    @PluginMethod
    public void openMaintenance(PluginCall call) {
        if (!KioskController.isKioskDevice(getContext())) {
            call.reject("Not a kiosk device");
            return;
        }
        remember(call);
        Intent intent = new Intent(getContext(), MaintenanceActivity.class);
        getActivity().startActivity(intent);
        call.resolve();
    }

    /** Sound + vibration for an important incoming message (kiosk only). */
    @PluginMethod
    public void alert(PluginCall call) {
        Context ctx = getContext();
        if (!KioskController.isKioskDevice(ctx)) {
            call.resolve();
            return;
        }
        Log.i(TAG, "message alert (sound + vibration)");
        try {
            Vibrator vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                long[] pattern = { 0, 400, 200, 400, 200, 400 };
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1));
                } else {
                    vibrator.vibrate(pattern, -1);
                }
            }
            Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            Ringtone ringtone = RingtoneManager.getRingtone(ctx, sound);
            if (ringtone != null) {
                // Notification usage, so it follows the phone's own
                // notification volume / silent mode like any other alert.
                ringtone.setAudioAttributes(
                    new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                );
                ringtone.play();
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "message alert failed", e);
        }
        call.resolve();
    }

    /**
     * Kiosk only: any navigation away from the bundled app (an external
     * link such as the privacy policy, tel:/mailto:, intent:, market:) is
     * blocked outright instead of being handed to Android as an ACTION_VIEW
     * intent — lock task mode would refuse to show another app anyway, but
     * not sending the intent at all is the safer default. JS is told so it
     * can explain. null keeps Capacitor's default policy on personal phones.
     */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (!KioskController.isKioskDevice(getContext())) return null;
        if (isAppUrl(url)) return null;
        Log.w(TAG, "blocked navigation in kiosk mode: " + url.getScheme() + "://" + url.getHost());
        JSObject data = new JSObject();
        data.put("url", url.toString());
        notifyListeners("navigationBlocked", data);
        return true;
    }

    private boolean isAppUrl(Uri url) {
        String scheme = url.getScheme();
        if ("data".equals(scheme) || "blob".equals(scheme)) return true;
        Uri app = Uri.parse(bridge.getAppUrl());
        return scheme != null && scheme.equals(app.getScheme()) && url.getHost() != null && url.getHost().equals(app.getHost());
    }

    private void remember(PluginCall call) {
        Integer pending = call.getInt("pendingCount");
        KioskController.rememberStatus(
            getContext(),
            call.getString("deviceIdentifier"),
            pending != null ? pending : -1,
            call.getString("lastSyncAt"),
            call.getString("employee")
        );
    }
}
