package com.linklogictechnologies.labourlink;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import com.linklogictechnologies.labourlink.kiosk.KioskController;
import com.linklogictechnologies.labourlink.kiosk.KioskPlugin;
import com.linklogictechnologies.labourlink.kiosk.MaintenanceActivity;

public class MainActivity extends BridgeActivity {

    // Cold-start-while-offline investigation (physical Ulefone Armor X13,
    // MediaTek/PRIZE-ODM Android 15 build): decisively proven, via a
    // completely stock zero-plugin Capacitor control app with no LabourLink
    // code, to be a device/WebView-level defect, not anything in this app.
    // Root mechanism confirmed via logcat: when offline, the WebView's
    // sandboxed renderer process (org.chromium.content.app
    // .SandboxedProcessService*) intermittently fails to spawn, and once
    // that happens Android's own ActivityManager marks this app's process
    // "bad" and silently refuses to even attempt starting the renderer
    // again ("Unable to launch app ... process is bad") for a cooldown
    // window it manages entirely outside this app's control — no
    // "Start proc" ever appears in logcat during that window, and the page
    // never begins loading.
    //
    // First attempt at a fix used AlarmManager + Runtime.exit(0) to kill and
    // relaunch the whole OS process. That turned out to be wrong twice
    // over: (1) on Android 10+ background-activity-start restrictions can
    // silently block a PendingIntent-triggered Activity launch once the
    // originating process is already dead — reproduced live, the relaunch
    // just never happened, dropping to the home screen; (2) killing the
    // process on every retry is itself another process death, which likely
    // feeds the same "bad process" tracking we're trying to route around,
    // risking a self-reinforcing loop instead of recovery.
    //
    // The fix below never kills the process. It calls Activity.recreate()
    // on the still-live, still-foregrounded activity — a normal, always-
    // permitted operation — which tears down and rebuilds the Capacitor
    // Bridge/WebView in place and gives the renderer a fresh bindService()
    // attempt, without ever registering as a process death. If that one
    // attempt is also exhausted, a plain native (non-WebView) screen with a
    // manual Retry button takes over — it can't depend on the WebView
    // working, since the WebView is exactly what's failing.
    //
    // Retry policy (revised 2026-09-14 after the Nattawat N incident — see
    // ColdStartWatchdog's own header for the full writeup): the original
    // version retried up to 20 times with increasing backoff, which on a
    // slow-but-NOT-dead device could recreate the Activity repeatedly while
    // real progress was happening, destroying it each time. All of the
    // actual timing/retry-cap/single-flight/cancellation decision logic now
    // lives in ColdStartWatchdog (plain Java, no Android framework
    // dependency, unit-testable) — this class only wires it to the real
    // Handler and Activity lifecycle. At most ONE automatic recovery
    // attempt per cold-start session now; a second miss goes straight to
    // the manual fallback, never a third recreate().
    private static final String TAG = "ColdStartWatchdog";

    // Static: shared across every MainActivity instance recreate() produces
    // within one process — a genuinely new cold start is a new process, so
    // this naturally starts fresh. See ColdStartWatchdog.Session's own doc.
    private static final ColdStartWatchdog.Session watchdogSession = new ColdStartWatchdog.Session();

    // No androidx.core.splashscreen.SplashScreen.installSplashScreen() call
    // here. Confirmed NOT related to the hang above (see comment block),
    // but restoring it isn't necessary for the watchdog fix, so it's left
    // out — the known tradeoff is the status/nav bar staying
    // transparent/unstyled instead of switching to postSplashScreenTheme.

    private final Handler watchdogHandler = new Handler(Looper.getMainLooper());
    private ColdStartWatchdog watchdog;

    /** Set by MaintenanceActivity's "Restart LabourLink". */
    public static final String EXTRA_RESTART = "com.linklogictechnologies.labourlink.RESTART";

    // Kiosk mode (see kiosk/KioskController). Every kiosk hook below is a
    // no-op unless the EMM has made this an enrolled kiosk device, so a
    // personal install behaves exactly as before.
    private final Handler kioskHandler = new Handler(Looper.getMainLooper());
    private final Runnable kioskMaintenanceExpiry = this::endMaintenanceAndRelock;
    private BroadcastReceiver kioskReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(KioskPlugin.class);
        super.onCreate(savedInstanceState);
        registerKioskReceiver();

        Log.i(TAG, "cold start beginning, recoveryAttempted=" + watchdogSession.recoveryAttempted);

        watchdog = new ColdStartWatchdog(
            watchdogSession,
            (delayMs, action) -> {
                Runnable r = action::run;
                watchdogHandler.postDelayed(r, delayMs);
                return () -> watchdogHandler.removeCallbacks(r);
            },
            new ColdStartWatchdog.Actions() {
                @Override
                public void recreateActivity() {
                    Log.w(TAG, "did not start within timeout — attempting the one automatic recovery (recreate)");
                    recreate();
                }

                @Override
                public void showManualFallback() {
                    Log.e(TAG, "did not start within timeout after the one automatic recovery was already used — showing manual fallback");
                    showManualRetryUi();
                }
            }
        );
        watchdog.start();

        this.bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageStarted(WebView webView) {
                    markPageStarted();
                }

                @Override
                public void onPageLoaded(WebView webView) {
                    markPageStarted();
                }

                // Capacitor's default returns false, which tells Android to
                // kill the whole app process when the WebView renderer dies
                // (reclaimed while backgrounded overnight, or crashed). A
                // process death is exactly what feeds the "process is bad"
                // renderer-spawn cooldown documented above, i.e. a white
                // screen on the next open. Handle it in place instead:
                // rebuild the WebView via recreate(), same as the
                // watchdog's own recovery. Local SQLite/localStorage are
                // untouched, so identity and pending events survive.
                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    // Only ever invoked on API 26+ (minSdk is 24), hence the guard.
                    String why = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? "didCrash=" + detail.didCrash() + ", rendererPriorityAtExit=" + detail.rendererPriorityAtExit()
                        : "no detail";
                    Log.e(TAG, "WebView render process gone (" + why + ") — recreating the activity instead of letting the process die");
                    watchdogHandler.post(MainActivity.this::recreate);
                    return true;
                }
            }
        );
    }

    @Override
    public void onResume() {
        super.onResume();
        applyKiosk();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getBooleanExtra(EXTRA_RESTART, false)) {
            Log.i(TAG, "restart requested from maintenance — rebuilding the WebView");
            watchdogSession.recoveryAttempted = false;
            recreate();
        }
    }

    private void applyKiosk() {
        kioskHandler.removeCallbacks(kioskMaintenanceExpiry);
        if (!KioskController.isKioskDevice(this)) return;
        KioskController.enforce(this);
        // Other apps' overlay windows can't draw over LabourLink (API 31+;
        // the EMM's DISALLOW_CREATE_WINDOWS restriction covers older ones).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            getWindow().setHideOverlayWindows(true);
        }
        if (KioskController.isMaintenanceActive(this)) {
            long remaining = KioskController.maintenanceUntil(this) - System.currentTimeMillis();
            kioskHandler.postDelayed(kioskMaintenanceExpiry, Math.max(0L, remaining));
        }
    }

    private void endMaintenanceAndRelock() {
        if (!KioskController.isKioskDevice(this)) return;
        if (KioskController.maintenanceUntil(this) != 0L) {
            Log.i(TAG, "maintenance exit ended — re-entering kiosk");
            KioskController.endMaintenance(this);
        }
        KioskController.enforce(this);
    }

    // Managed-configuration changes (the EMM turning kiosk on/off or
    // rotating the credential) apply immediately; the screen turning off
    // ends any maintenance exit so a phone can't be left unlocked.
    // ACTION_APPLICATION_RESTRICTIONS_CHANGED is only ever delivered to
    // dynamically registered receivers.
    private void registerKioskReceiver() {
        kioskReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!KioskController.isKioskDevice(MainActivity.this)) return;
                if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) {
                    if (KioskController.maintenanceUntil(MainActivity.this) != 0L) {
                        Log.i(TAG, "screen off — ending maintenance exit");
                        KioskController.endMaintenance(MainActivity.this);
                    }
                    return;
                }
                Log.i(TAG, "managed configuration changed");
                applyKiosk();
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        // Both are system broadcasts; RECEIVER_NOT_EXPORTED is still
        // required to be stated on API 33+ for any dynamic receiver.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(kioskReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(kioskReceiver, filter);
        }
    }

    private void markPageStarted() {
        Log.i(TAG, "page started/loaded — cancelling the watchdog");
        watchdog.markReady();
    }

    @Override
    public void onDestroy() {
        // Cancel immediately, unconditionally, and before anything else —
        // lifecycle-aware: an instance being torn down (its own recreate(),
        // or the user leaving mid-start) can never have its scheduled check
        // fire afterward.
        watchdog.cancel();
        watchdogHandler.removeCallbacksAndMessages(null);
        kioskHandler.removeCallbacksAndMessages(null);
        if (kioskReceiver != null) {
            unregisterReceiver(kioskReceiver);
            kioskReceiver = null;
        }
        super.onDestroy();
    }

    // Plain native View tree — deliberately not touching the WebView/Bridge
    // at all, since the WebView is exactly what has failed to start after
    // the one automatic recovery attempt. Tapping Retry starts a fresh
    // one-recovery-attempt budget from zero.
    private void showManualRetryUi() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        int pad = (int) (32 * getResources().getDisplayMetrics().density);
        layout.setPadding(pad, pad, pad, pad);
        layout.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("LabourLink couldn't start");
        title.setTextSize(20);
        title.setGravity(Gravity.CENTER);
        title.setTextColor(Color.BLACK);
        attachMaintenanceHold(title);

        TextView message = new TextView(this);
        message.setText(
            "This can happen when the phone has no signal. Tap Retry to try again.\n\n" +
            "If Retry keeps not working, restarting the phone (power button > Restart) fixes it."
        );
        message.setTextSize(15);
        message.setGravity(Gravity.CENTER);
        message.setTextColor(Color.DKGRAY);
        message.setPadding(0, pad / 2, 0, pad);

        Button retryButton = new Button(this);
        retryButton.setText("Retry");
        retryButton.setOnClickListener(
            v -> {
                Log.i(TAG, "manual retry tapped, starting a fresh one-recovery-attempt budget");
                watchdogSession.recoveryAttempted = false;
                recreate();
            }
        );

        layout.addView(
            title,
            new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        );
        layout.addView(
            message,
            new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        );
        layout.addView(
            retryButton,
            new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        );

        setContentView(layout);
    }

    // Kiosk only: holding the title for five seconds opens the native
    // maintenance screen, so an administrator can still reach Wi-Fi /
    // restart / kiosk exit when the WebView itself won't start.
    private void attachMaintenanceHold(TextView view) {
        if (!KioskController.isKioskDevice(this)) return;
        Runnable open = () -> startActivity(new Intent(this, MaintenanceActivity.class));
        view.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    kioskHandler.postDelayed(open, 5000);
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    kioskHandler.removeCallbacks(open);
                    return true;
                default:
                    return true;
            }
        });
    }
}
