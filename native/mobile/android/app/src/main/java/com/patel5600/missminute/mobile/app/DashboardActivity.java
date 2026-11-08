package com.patel5600.missminute.mobile.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.fragment.app.FragmentActivity;

import com.patel5600.missminute.mobile.BuildConfig;
import com.patel5600.missminute.mobile.MainActivity;
import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.HelloHandler;
import com.patel5600.missminute.mobile.bridge.WebHost;
import com.patel5600.missminute.mobile.bridge.handlers.KillHandlers;
import com.patel5600.missminute.mobile.bridge.handlers.OverlayHandlers;
import com.patel5600.missminute.mobile.bridge.handlers.PermissionHandlers;
import com.patel5600.missminute.mobile.bridge.handlers.SettingsHandlers;
import com.patel5600.missminute.mobile.bridge.handlers.UiBridge;
import com.patel5600.missminute.mobile.core.kill.KillPath;
import com.patel5600.missminute.mobile.core.kill.KillState;
import com.patel5600.missminute.mobile.core.protocol.Protocol;
import com.patel5600.missminute.mobile.core.protocol.Role;
import com.patel5600.missminute.mobile.core.runtime.CompanionRuntime;
import com.patel5600.missminute.mobile.kill.KillSwitch;
import com.patel5600.missminute.mobile.overlay.OverlayService;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The app screen (the launcher). A native header with the status and a red Stop Miss Minutes button
 * that always works, even if the page hangs, above the dashboard page. It also owns the permission
 * flows: notifications, and Display over other apps (checked again in onResume).
 */
public final class DashboardActivity extends FragmentActivity implements UiBridge {
    /** Debug builds only: start her as if the owner pressed the button (adb am start --ez ... true). */
    static final String EXTRA_DEBUG_AUTOSTART = "com.patel5600.missminute.debug.AUTOSTART";
    private static final int REQUEST_NOTIFICATIONS = 4201;

    private MissMinutesApp app;
    private WebHost web;
    private LinearLayout root;
    private FrameLayout pageHolder;
    private TextView status;
    private Button stopButton;
    private CompanionRuntime.Registration runtimeRegistration;

    private final KillSwitch.Listener killListener = new KillSwitch.Listener() {
        @Override
        public void onKilled(final KillState state) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    refreshHeader();
                    try {
                        push("kill.happened", new JSONObject().put("atMs", state.atMs).put("path", state.path.wireName));
                    } catch (JSONException ignored) {
                        // the page learns of the kill from its next status request
                    }
                }
            });
        }
    };

    private final CompanionRuntime.Listener runtimeListener = new CompanionRuntime.Listener() {
        @Override
        public void onChanged(final CompanionRuntime.Snapshot snapshot) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (isFinishing() || isDestroyed()) return;
                    refreshHeader();
                    try {
                        push("state.changed", new JSONObject().put("runtime", snapshot.toJson()));
                    } catch (JSONException ignored) {
                        // The dashboard reconciles against the authoritative status on its next refresh.
                    }
                }
            });
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        app = MissMinutesApp.from(this);
        buildLayout();
        buildPage();
        handleIntent(getIntent());
    }

    // ---- layout ------------------------------------------------------------------------------

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void buildLayout() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.mm_base));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setBackgroundColor(getColor(R.color.mm_raised));
        header.setPadding(dp(16), dp(8), dp(12), dp(8));

        status = new TextView(this);
        status.setTextColor(getColor(R.color.mm_cream));
        status.setTextSize(14);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        header.addView(status, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        stopButton = new Button(this);
        stopButton.setText(R.string.action_stop);
        stopButton.setContentDescription(getString(R.string.action_stop));
        stopButton.setAllCaps(false);
        stopButton.setTextColor(Color.WHITE);
        stopButton.setTypeface(Typeface.DEFAULT_BOLD);
        stopButton.setTextSize(14);
        stopButton.setMinHeight(dp(48));
        stopButton.setMinimumHeight(dp(48));
        stopButton.setPadding(dp(14), 0, dp(14), 0);
        GradientDrawable red = new GradientDrawable();
        red.setColor(getColor(R.color.mm_stop));
        red.setCornerRadius(dp(10));
        stopButton.setBackground(red);
        stopButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // The same kill switch as the notification and her menu. No page is involved.
                KillSwitch.trigger(DashboardActivity.this, KillPath.APP_BUTTON);
                refreshHeader();
            }
        });
        LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stopParams.setMarginStart(dp(8));
        header.addView(stopButton, stopParams);

        root.addView(header, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        pageHolder = new FrameLayout(this);
        root.addView(pageHolder, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        applyInsets();
    }

    /** Target SDK 36 draws edge to edge: keep the content out of the bars, the cutout and the keyboard. */
    private void applyInsets() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            root.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                if (Build.VERSION.SDK_INT >= 30) {
                    Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                    view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                    return WindowInsets.CONSUMED;
                }
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                return insets.consumeSystemWindowInsets();
            }
        });
        root.requestApplyInsets();
    }

    private void buildPage() {
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD);
        router.register("hello", new HelloHandler(Role.DASHBOARD, null, new HelloHandler.DashboardInfo() {
            @Override
            public JSONObject describe() throws JSONException {
                return DashboardActivity.this.describeForHello();
            }
        }));
        OverlayHandlers.register(router, this, this);
        SettingsHandlers.register(router, this, this);
        KillHandlers.register(router, this, this);
        PermissionHandlers.register(router, this, this);

        web = WebHost.create(this, Role.DASHBOARD, router, new WebHost.Callbacks() {
            @Override
            public void onProblem(String reason) {
                showProblem(getString(R.string.dashboard_webview_unsupported));
            }
        });
        if (web.attachTo(pageHolder, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) == null) {
            showProblem(getString(R.string.dashboard_webview_unsupported));
        }
    }

    private void showProblem(String text) {
        pageHolder.removeAllViews();
        TextView message = new TextView(this);
        message.setText(text);
        message.setTextColor(getColor(R.color.mm_cream));
        message.setTextSize(16);
        message.setGravity(Gravity.CENTER);
        message.setPadding(dp(24), dp(24), dp(24), dp(24));
        pageHolder.addView(message, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** What the dashboard learns when it says hello. */
    private JSONObject describeForHello() throws JSONException {
        JSONObject permissions = PermissionHandlers.describe(app);
        JSONObject out = new JSONObject()
                .put("mode", permissions.getString("mode"))
                .put("proactive", permissions.getBoolean("proactive"))
                .put("version", BuildConfig.VERSION_NAME)
                .put("sdk", Build.VERSION.SDK_INT)
                .put("overlay", OverlayHandlers.status(this, this))
                .put("settings", SettingsHandlers.all(app));
        JSONObject notice = KillHandlers.notice(this);
        out.put("killNotice", notice == null ? JSONObject.NULL : notice);
        return out;
    }

    // ---- lifecycle ---------------------------------------------------------------------------

    @Override
    protected void onStart() {
        super.onStart();
        app.killSwitch().addListener(killListener);
        runtimeRegistration = CompanionRuntime.process().observe(runtimeListener, true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        refreshHeader();
        push("state.changed", new JSONObject());
    }

    @Override
    protected void onPause() {
        web.onPause(false);
        super.onPause();
    }

    @Override
    protected void onStop() {
        app.killSwitch().removeListener(killListener);
        if (runtimeRegistration != null) {
            runtimeRegistration.unregister();
            runtimeRegistration = null;
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig); // the manifest lists these changes, so the page keeps its state
        root.requestApplyInsets();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_NOTIFICATIONS) {
            refreshHeader();
            push("state.changed", new JSONObject());
        }
    }

    private void handleIntent(Intent intent) {
        if (BuildConfig.DEBUG && intent != null && intent.getBooleanExtra(EXTRA_DEBUG_AUTOSTART, false)) {
            OverlayService.start(this);
        }
    }

    /** Status is rendered from the service-owned state machine, never from the page's last tap. */
    private void refreshHeader() {
        CompanionRuntime.Snapshot runtime = CompanionRuntime.process().snapshot();
        boolean running = runtime.state == CompanionRuntime.State.RUNNING
                || runtime.state == CompanionRuntime.State.RECOVERING;
        if (stopButton != null) {
            stopButton.setVisibility(running ? View.VISIBLE : View.GONE);
            stopButton.setEnabled(runtime.state == CompanionRuntime.State.RUNNING
                    || runtime.state == CompanionRuntime.State.RECOVERING);
        }

        CharSequence text;
        switch (runtime.state) {
            case STARTING:
                text = "Starting Miss Minutes…";
                break;
            case RUNNING:
                switch (OverlayService.visibilityName()) {
                    case "DOCKED": text = getString(R.string.header_status_docked); break;
                    case "PAUSED": text = getString(R.string.header_status_paused); break;
                    case "HIDDEN": text = getString(R.string.header_status_hidden); break;
                    default: text = getString(R.string.header_status_running); break;
                }
                break;
            case STOPPING:
                text = "Stopping Miss Minutes…";
                break;
            case FAILED:
                text = "Miss Minutes failed: " + (runtime.reason == null ? "unknown error" : runtime.reason);
                break;
            case PERMISSION_BLOCKED:
                text = "Display over other apps permission required";
                break;
            case RECOVERING:
                text = "Reconnecting Miss Minutes…";
                break;
            case STOPPED:
            default:
                if (app.killSwitch().state().killed) {
                    text = getString(R.string.header_status_stopped);
                } else if (!android.provider.Settings.canDrawOverlays(this)) {
                    text = getString(R.string.dashboard_overlay_denied);
                } else {
                    text = getString(R.string.header_status_off);
                }
                break;
        }
        status.setText(text);
    }

    // ---- UiBridge ----------------------------------------------------------------------------

    @Override
    public void runOnUi(Runnable action) {
        runOnUiThread(action);
    }

    @Override
    public void confirm(int titleRes, int messageRes, UiBridge.Confirmed result) {
        NativeDialogs.confirm(this, titleRes, messageRes, result);
    }

    @Override
    public void openOverlayPermissionScreen() {
        startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getPackageName())));
    }

    @Override
    public void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        }
    }

    @Override
    public boolean notificationsGranted() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        return manager != null && manager.areNotificationsEnabled();
    }

    @Override
    public void openMetadataWatcher() {
        startActivity(new Intent(this, MainActivity.class));
    }

    @Override
    public void push(String eventName, JSONObject payload) {
        if (web != null) {
            web.send(Protocol.event(eventName, payload));
        }
    }
}
