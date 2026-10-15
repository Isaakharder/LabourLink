package com.linklogictechnologies.kiosktestdpc;

import android.app.Activity;
import android.app.ActivityOptions;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.TextView;

/** Relaunches LabourLink whenever the kiosk "home" comes to the front. */
public class KioskHomeActivity extends Activity {

    static final String TAG = "KioskTestDpc";
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView t = new TextView(this);
        t.setText("Kiosk Test DPC — starting LabourLink…");
        t.setPadding(48, 48, 48, 48);
        setContentView(t);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.postDelayed(this::launch, 1000);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacksAndMessages(null);
    }

    private void launch() {
        Intent intent = getPackageManager().getLaunchIntentForPackage(CommandReceiver.LABOURLINK);
        if (intent == null) {
            Log.w(TAG, "LabourLink not installed");
            return;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        SharedPreferences p = getSharedPreferences("dpc", MODE_PRIVATE);
        Bundle opts = null;
        if (p.getBoolean("launch_locked", false)) {
            // How AMAPI's Android Device Policy starts an installType=KIOSK app.
            ActivityOptions o = ActivityOptions.makeBasic();
            o.setLockTaskEnabled(true);
            opts = o.toBundle();
        }
        Log.i(TAG, "launching LabourLink (launch_locked=" + (opts != null) + ")");
        startActivity(intent, opts);
    }
}
