package com.labourlink.app;

import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Must run before super.onCreate() — this is what actually applies
    // AppTheme.NoActionBarLaunch's postSplashScreenTheme (see styles.xml) once
    // the splash is dismissed. Without this call the activity never leaves
    // the splash theme (transparent status/nav bar, fitsSystemWindows=false,
    // no content inset handling) for its entire lifetime, which is why the
    // status bar was invisible/overlaid rather than a normal system bar.
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
    }
}
