package com.labourlink.app;

import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

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
    // attempt, without ever registering as a process death. retryCount is
    // static so it naturally survives recreate() within the same process.
    // If every automatic attempt is exhausted, a plain native (non-WebView)
    // screen with a manual Retry button takes over — it can't depend on the
    // WebView working, since the WebView is exactly what's failing.
    // Empirically, once the "bad process" mark triggers it can outlast
    // several minutes of retries (measured: 16 retries over 3.5 minutes all
    // failed) — only a full device reboot was observed to clear it
    // immediately. These constants trade off a patient automatic-recovery
    // window (~8 minutes worst case) against not leaving the app
    // unresponsive indefinitely before falling back to the manual screen.
    private static final String TAG = "ColdStartWatchdog";
    private static final long WATCHDOG_INITIAL_DELAY_MS = 5000;
    private static final long WATCHDOG_BACKOFF_STEP_MS = 2000;
    private static final long WATCHDOG_MAX_DELAY_MS = 60000;
    private static final int WATCHDOG_MAX_RETRIES = 20;

    private static int retryCount = 0;

    // No androidx.core.splashscreen.SplashScreen.installSplashScreen() call
    // here. Confirmed NOT related to the hang above (see comment block),
    // but restoring it isn't necessary for the watchdog fix, so it's left
    // out — the known tradeoff is the status/nav bar staying
    // transparent/unstyled instead of switching to postSplashScreenTheme.

    private final Handler watchdogHandler = new Handler(Looper.getMainLooper());
    private volatile boolean pageStarted = false;
    private Runnable watchdogRunnable;
    private long attemptStartedAtMs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        attemptStartedAtMs = System.currentTimeMillis();
        Log.i(TAG, "cold start attempt #" + retryCount + " beginning");

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
            }
        );

        if (retryCount < WATCHDOG_MAX_RETRIES) {
            long delay = Math.min(WATCHDOG_INITIAL_DELAY_MS + retryCount * WATCHDOG_BACKOFF_STEP_MS, WATCHDOG_MAX_DELAY_MS);
            watchdogRunnable = () -> {
                if (!pageStarted) {
                    long elapsed = System.currentTimeMillis() - attemptStartedAtMs;
                    Log.w(TAG, "attempt #" + retryCount + " did not start within " + elapsed + "ms, recreating activity");
                    retryCount++;
                    recreate();
                }
            };
            watchdogHandler.postDelayed(watchdogRunnable, delay);
        } else {
            watchdogRunnable = () -> {
                if (!pageStarted) {
                    long elapsed = System.currentTimeMillis() - attemptStartedAtMs;
                    Log.e(TAG, "attempt #" + retryCount + " did not start within " + elapsed + "ms, all automatic retries exhausted");
                    showManualRetryUi();
                }
            };
            watchdogHandler.postDelayed(watchdogRunnable, WATCHDOG_MAX_DELAY_MS);
        }
    }

    private void markPageStarted() {
        if (pageStarted) {
            return;
        }
        pageStarted = true;
        long elapsed = System.currentTimeMillis() - attemptStartedAtMs;
        Log.i(TAG, "attempt #" + retryCount + " started successfully after " + elapsed + "ms");
        retryCount = 0;
        if (watchdogRunnable != null) {
            watchdogHandler.removeCallbacks(watchdogRunnable);
        }
    }

    @Override
    public void onDestroy() {
        watchdogHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    // Plain native View tree — deliberately not touching the WebView/Bridge
    // at all, since the WebView is exactly what has failed to start after
    // WATCHDOG_MAX_RETRIES automatic attempts. Tapping Retry resets the
    // count and starts a fresh bounded retry sequence from zero.
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
                Log.i(TAG, "manual retry tapped, resetting attempt count");
                retryCount = 0;
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
}
