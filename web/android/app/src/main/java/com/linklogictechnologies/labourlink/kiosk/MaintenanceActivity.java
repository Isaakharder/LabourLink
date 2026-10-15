package com.linklogictechnologies.labourlink.kiosk;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import com.linklogictechnologies.labourlink.MainActivity;
import java.text.DateFormat;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hidden administrator maintenance screen for kiosk devices. Plain native
 * views on purpose — it has to keep working when the WebView is exactly
 * what's broken (it's reachable from MainActivity's native fallback screen
 * as well as from the web app's 5-second hold).
 *
 * Nothing is shown or possible until the maintenance PIN is verified
 * against the per-device salted hash (KioskCredential); there is no PIN in
 * the APK, and verification is local, so it works offline. Runs inside the
 * same locked task as MainActivity, and closes itself after two minutes of
 * inactivity.
 */
public class MaintenanceActivity extends Activity {

    private static final String TAG = "LabourLinkKiosk";
    private static final long IDLE_TIMEOUT_MS = 2 * 60 * 1000L;
    // The Wi-Fi unlock is short and self-limiting: if the panel never shows
    // (or the admin wanders off), the phone relocks within this window
    // instead of staying open for a full maintenance exit.
    private static final long WIFI_UNLOCK_MS = 5 * 60 * 1000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Runnable idleTimeout = this::finish;
    private boolean unlocked = false;
    private boolean returningFromWifi = false;
    private boolean resumed = false;
    private int pad;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // No screenshots / recents thumbnail of the maintenance screen.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        pad = (int) (20 * getResources().getDisplayMetrics().density);
        if (!KioskController.isKioskDevice(this)) {
            finish();
            return;
        }
        showPinEntry(null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        resetIdleTimer();
        if (returningFromWifi) {
            // Back from the Wi-Fi panel: the temporary unlock that let it
            // open ends here, never left running.
            returningFromWifi = false;
            KioskController.endMaintenance(this);
            KioskController.enforce(this);
            if (unlocked) showMenu();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        handler.removeCallbacks(idleTimeout);
    }

    @Override
    protected void onDestroy() {
        if (returningFromWifi) {
            // Closed by any route while the Wi-Fi unlock was open — end it;
            // MainActivity's onResume re-locks.
            KioskController.endMaintenance(this);
        }
        handler.removeCallbacksAndMessages(null);
        worker.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onUserInteraction() {
        super.onUserInteraction();
        resetIdleTimer();
    }

    private void resetIdleTimer() {
        handler.removeCallbacks(idleTimeout);
        handler.postDelayed(idleTimeout, IDLE_TIMEOUT_MS);
    }

    // ---- PIN gate ---------------------------------------------------------

    private void showPinEntry(String error) {
        unlocked = false;
        LinearLayout root = column();
        root.addView(title("LabourLink maintenance"));

        if (!KioskController.hasUsableCredential(this)) {
            root.addView(text("No maintenance credential is configured for this device. Set maintenance_credential for LabourLink in the device management console, then try again."));
            root.addView(button("Close", v -> finish()));
            setContentView(wrap(root));
            return;
        }

        if (KioskController.isLockedOut(this)) {
            long secs = (KioskController.lockoutRemainingMs(this) + 999) / 1000;
            root.addView(text("Too many incorrect attempts. Try again in " + secs + " seconds."));
            root.addView(button("Close", v -> finish()));
            setContentView(wrap(root));
            handler.postDelayed(() -> showPinEntry(null), Math.min(secs, 30) * 1000L);
            return;
        }

        root.addView(text("Enter the maintenance PIN."));
        EditText pin = new EditText(this);
        pin.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        pin.setHint("PIN");
        pin.setGravity(Gravity.CENTER);
        root.addView(pin);
        if (error != null) {
            TextView err = text(error);
            err.setTextColor(Color.rgb(176, 0, 32));
            root.addView(err);
        }
        Button unlock = button("Unlock", null);
        unlock.setOnClickListener(v -> {
            String entered = pin.getText().toString();
            pin.setText("");
            unlock.setEnabled(false);
            unlock.setText("Checking…");
            worker.execute(() -> {
                boolean ok = KioskController.verifyPin(this, entered);
                handler.post(() -> {
                    if (isFinishing()) return;
                    if (ok) {
                        Log.i(TAG, "maintenance unlocked");
                        showMenu();
                    } else {
                        Log.w(TAG, "maintenance PIN rejected");
                        showPinEntry("Incorrect PIN.");
                    }
                });
            });
        });
        root.addView(unlock);
        root.addView(button("Cancel", v -> finish()));
        setContentView(wrap(root));
        pin.requestFocus();
    }

    // ---- unlocked menu ----------------------------------------------------

    private void showMenu() {
        unlocked = true;
        LinearLayout root = column();
        root.addView(title("LabourLink maintenance"));

        boolean maintenance = KioskController.isMaintenanceActive(this);
        root.addView(button("Wi-Fi settings", v -> openWifi()));
        root.addView(button("Restart LabourLink", v -> restartApp()));
        if (maintenance) {
            root.addView(button("Re-enter kiosk mode", v -> {
                KioskController.endMaintenance(this);
                KioskController.enforce(this);
                Toast.makeText(this, "Kiosk mode re-entered", Toast.LENGTH_SHORT).show();
                showMenu();
            }));
        } else {
            root.addView(button("Exit kiosk for 30 minutes", v -> confirm(
                "Exit kiosk mode?",
                "Home, Recents and other apps become reachable for 30 minutes, or until the screen turns off or you choose Re-enter kiosk mode.",
                () -> {
                    KioskController.beginMaintenance(this);
                    Toast.makeText(this, "Kiosk paused for maintenance", Toast.LENGTH_SHORT).show();
                    showMenu();
                }
            )));
        }
        root.addView(button("Change maintenance PIN", v -> showChangePin()));
        root.addView(button("Close", v -> finish()));
        // Actions first so they're reachable without scrolling on a small
        // screen; the status block follows.
        root.addView(text(statusText()));
        setContentView(wrap(root));
    }

    private String statusText() {
        StringBuilder sb = new StringBuilder();
        String version = "?";
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            version = info.versionName + " (build " + code + ")";
        } catch (PackageManager.NameNotFoundException ignored) {}
        KioskController.LastStatus s = KioskController.lastStatus(this);
        DateFormat fmt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT);

        line(sb, "App version", version);
        line(sb, "Device label", orDash(KioskController.deviceLabel(this)));
        line(sb, "Device identity", orDash(s.deviceId));
        line(sb, "Paired to", orDash(s.employee));
        line(sb, "Kiosk status", KioskController.describeLockState(this));
        if (KioskController.isMaintenanceActive(this)) {
            long mins = Math.max(1, (KioskController.maintenanceUntil(this) - System.currentTimeMillis()) / 60000);
            line(sb, "Maintenance exit", "about " + mins + " min left");
        }
        line(sb, "Pending events", s.pendingCount >= 0 ? String.valueOf(s.pendingCount) : "unknown");
        line(sb, "Last sync", orDash(s.lastSyncAt));
        line(sb, "Status reported", s.reportedAt > 0 ? fmt.format(new Date(s.reportedAt)) : "never");
        line(sb, "Network", networkText());
        line(sb, "Android", Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + "), " + Build.MANUFACTURER + " " + Build.MODEL);
        return sb.toString();
    }

    private String networkText() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return "unknown";
        NetworkCapabilities caps = cm.getNetworkCapabilities(cm.getActiveNetwork());
        if (caps == null) return "offline";
        String type = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            ? "Wi-Fi"
            : caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "mobile data" : "other";
        boolean validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        return type + (validated ? ", internet OK" : ", no internet");
    }

    // ---- actions ------------------------------------------------------------

    private void openWifi() {
        // Settings isn't in the lock task allowlist (and must never be), so
        // the panel can only open after a short, authenticated unlock that
        // onResume() closes again as soon as the admin comes back.
        KioskController.beginMaintenance(this, WIFI_UNLOCK_MS);
        returningFromWifi = true;
        launchWifiWhenUnlocked(0);
    }

    // stopLockTask() is asynchronous: starting Settings in the same instant
    // can still hit lock task and be refused silently ("Lock Task Mode
    // violation", no exception). So wait — briefly — for Android to report
    // the unlock, then launch, then confirm the panel actually came up.
    private void launchWifiWhenUnlocked(int attempt) {
        if (!returningFromWifi || isFinishing()) return;
        if (KioskController.isLocked(this)) {
            if (attempt < 20) {
                handler.postDelayed(() -> launchWifiWhenUnlocked(attempt + 1), 100);
            } else {
                abortWifi("Couldn't leave kiosk mode to open Wi-Fi settings.");
            }
            return;
        }
        Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? new Intent(Settings.Panel.ACTION_WIFI)
            : new Intent(Settings.ACTION_WIFI_SETTINGS);
        try {
            startActivity(intent);
        } catch (RuntimeException e) {
            Log.e(TAG, "could not open Wi-Fi settings", e);
            abortWifi("Wi-Fi settings are blocked on this device. Configure Wi-Fi from the device management console.");
            return;
        }
        // Still in front 3 s later means the panel never appeared (refused
        // or blocked by the OEM/EMM) — never leave the phone unlocked for it.
        handler.postDelayed(() -> {
            if (returningFromWifi && resumed && !isFinishing()) {
                abortWifi("Wi-Fi settings couldn't be opened on this device.");
            }
        }, 3000);
    }

    private void abortWifi(String message) {
        Log.w(TAG, "Wi-Fi panel did not open — relocking: " + message);
        returningFromWifi = false;
        KioskController.endMaintenance(this);
        KioskController.enforce(this);
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        if (unlocked) showMenu();
    }

    private void restartApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(MainActivity.EXTRA_RESTART, true);
        startActivity(intent);
        finish();
    }

    private void showChangePin() {
        LinearLayout root = column();
        root.addView(title("Change maintenance PIN"));
        root.addView(text("Digits only, " + KioskCredential.MIN_PIN_LENGTH + " to " + KioskCredential.MAX_PIN_LENGTH + " long. Stored on this phone as a salted hash. Changing maintenance_credential in the device management console later replaces it."));
        EditText first = pinField("New PIN");
        EditText second = pinField("Repeat new PIN");
        root.addView(first);
        root.addView(second);
        Button save = button("Save", null);
        save.setOnClickListener(v -> {
            String a = first.getText().toString();
            String b = second.getText().toString();
            if (!KioskCredential.isAcceptablePin(a)) {
                Toast.makeText(this, "PIN must be " + KioskCredential.MIN_PIN_LENGTH + "-" + KioskCredential.MAX_PIN_LENGTH + " digits", Toast.LENGTH_LONG).show();
                return;
            }
            if (!a.equals(b)) {
                Toast.makeText(this, "PINs don't match", Toast.LENGTH_LONG).show();
                return;
            }
            save.setEnabled(false);
            save.setText("Saving…");
            worker.execute(() -> {
                KioskController.setLocalPin(this, a);
                handler.post(() -> {
                    if (isFinishing()) return;
                    Log.i(TAG, "maintenance PIN changed locally");
                    Toast.makeText(this, "Maintenance PIN changed", Toast.LENGTH_SHORT).show();
                    showMenu();
                });
            });
        });
        root.addView(save);
        root.addView(button("Back", v -> showMenu()));
        setContentView(wrap(root));
    }

    private void confirm(String title, String message, Runnable onYes) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(message).setPositiveButton("Continue", (d, w) -> onYes.run()).setNegativeButton("Cancel", null).show();
    }

    // ---- view helpers -------------------------------------------------------

    private LinearLayout column() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(pad, pad, pad, pad);
        return l;
    }

    private View wrap(LinearLayout content) {
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Color.WHITE);
        sv.setFitsSystemWindows(true);
        sv.addView(content);
        return sv;
    }

    private TextView title(String s) {
        TextView t = text(s);
        t.setTextSize(22);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView text(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(15);
        t.setTextColor(Color.rgb(33, 33, 33));
        t.setPadding(0, pad / 2, 0, pad / 2);
        return t;
    }

    private Button button(String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        if (onClick != null) b.setOnClickListener(onClick);
        return b;
    }

    private EditText pinField(String hint) {
        EditText e = new EditText(this);
        e.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        e.setHint(hint);
        return e;
    }

    private static void line(StringBuilder sb, String label, String value) {
        sb.append(label).append(": ").append(value).append('\n');
    }

    private static String orDash(String s) {
        return s == null || s.isEmpty() ? "—" : s;
    }
}
