package com.patel5600.missminute.mobile.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.fragment.app.FragmentActivity;

import com.patel5600.missminute.mobile.BuildConfig;
import com.patel5600.missminute.mobile.MainActivity;
import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.HelloHandler;
import com.patel5600.missminute.mobile.bridge.WebHost;
import com.patel5600.missminute.mobile.bridge.handlers.KillHandlers;
import com.patel5600.missminute.mobile.bridge.handlers.ChatGptHandlers;
import com.patel5600.missminute.mobile.bridge.handlers.OverlayHandlers;
import com.patel5600.missminute.mobile.bridge.handlers.OwnerDataHandlers;
import com.patel5600.missminute.mobile.bridge.handlers.OwnerHandlers;
import com.patel5600.missminute.mobile.bridge.handlers.ProviderHandlers;
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
import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.ref.WeakReference;

/**
 * The app screen (the launcher). A native header with the status and a red Stop Miss Minutes button
 * that always works, even if the page hangs, above the dashboard page. It also owns the permission
 * flows: notifications, and Display over other apps (checked again in onResume).
 */
public final class DashboardActivity extends FragmentActivity implements UiBridge {
    /** Debug builds only: start her as if the owner pressed the button (adb am start --ez ... true). */
    static final String EXTRA_DEBUG_AUTOSTART = "com.patel5600.missminute.debug.AUTOSTART";
    private static final int REQUEST_NOTIFICATIONS = 4201;
    private static final long OWNER_SESSION_CHECK_MS = 5_000L;

    private MissMinutesApp app;
    private WebHost web;
    private WebHost migrationWeb;
    private LinearLayout root;
    private FrameLayout pageHolder;
    private FrameLayout migrationHolder;
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
                    if (OwnerAuthority.isEnrolled(DashboardActivity.this)) OwnerAuthority.lock();
                    cancelOwnerMigration("Owner was locked. Verify again to resume migration.");
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
        activeDashboard = new WeakReference<>(this);
        app = MissMinutesApp.from(this);
        if (OwnerAuthority.isEnrolled(this)) OwnerAuthority.restore(this);
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
                if (OwnerAuthority.isEnrolled(DashboardActivity.this)) OwnerAuthority.lock();
                cancelOwnerMigration("Owner was locked. Verify again to resume migration.");
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

        migrationHolder = new FrameLayout(this);
        migrationHolder.setVisibility(View.INVISIBLE);
        root.addView(migrationHolder, new LinearLayout.LayoutParams(dp(1), dp(1)));

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
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD, OwnerAuthority::hasOwnerSession);
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
        ChatGptHandlers.register(router, this);
        OwnerDataHandlers.register(router, this);
        OwnerHandlers.register(router, this, this);
        ProviderHandlers.register(router, this);
        router.register("owner.migration.start", (message, reply) -> {
            if (!OwnerAuthority.hasOwnerSession()
                    || !OwnerAuthority.authorizeOwnerCapability("memory.private.read")) {
                reply.fail("owner_auth_required", "Verify the owner before moving saved data.");
                return;
            }
            runOnUiThread(() -> beginOwnerMigration(reply));
        });
        router.register("owner.setup.consent", (message, reply) -> runOnUiThread(() -> new AlertDialog.Builder(this)
                .setTitle("Local camera and microphone setup")
                .setMessage("Face and speaker profiles are optional and processed on this device. Camera and microphone start only after you open and start each setup step; this app does not run a background camera or wake-word listener yet. Sensor access can be paused by closing the setup screen or changing Android permissions. Staged profiles stay encrypted and inactive until the initial owner credential is verified.")
                .setNegativeButton("Cancel", (dialog, which) -> reply.fail("cancelled", "Sensor setup consent was not given."))
                .setPositiveButton("I understand", (dialog, which) -> {
                    boolean saved = getSharedPreferences("owner_setup", MODE_PRIVATE).edit()
                            .putBoolean("sensor_consent_v1", true).commit();
                    if (!saved) { reply.fail("internal", "Consent could not be saved; sensor setup has not started."); return; }
                    try { reply.ok(new JSONObject().put("consented", true)); }
                    catch (JSONException error) { reply.fail("internal", "Consent was saved, but its status could not be returned."); }
                    push("state.changed", new JSONObject());
                }).show()));
        router.register("owner.setup.enroll", (message, reply) -> {
            if (!getSharedPreferences("owner_setup", MODE_PRIVATE).getBoolean("sensor_consent_v1", false)) {
                reply.fail("forbidden", "Review the first-run privacy and sensor disclosure before owner setup.");
                return;
            }
            if (OwnerAuthority.isEnrolled(this)) {
                OwnerAuthority.authenticate(this, (sessionId, error) -> {
                    if (error != null) reply.fail("owner_auth_required", error);
                    else finishOwnerSetup(reply);
                    runOnUiThread(() -> { refreshOwnerButton(); push("state.changed", new JSONObject()); });
                });
                return;
            }
            boolean pendingSaved = getSharedPreferences("owner_setup", MODE_PRIVATE).edit()
                    .putBoolean("owner_claim_pending_v1", true).commit();
            if (!pendingSaved) { reply.fail("internal", "Could not save setup progress; the owner claim was not started."); return; }
            runOnUiThread(() -> new AlertDialog.Builder(this)
                    .setTitle("Verify the initial owner claim")
                    .setMessage("Your staged local face and speaker profiles will activate only after Android verifies you and creates this device's protected signing key. This step establishes authority; recognition alone never does.")
                    .setNegativeButton("Not now", (dialog, which) -> reply.fail("cancelled", "Owner setup was cancelled."))
                    .setPositiveButton("Continue", (dialog, which) -> OwnerAuthority.enrollAndAuthenticate(this, (sessionId, error) -> {
                        if (error != null) reply.fail("owner_auth_required", error);
                        else finishOwnerSetup(reply);
                        refreshHeader(); refreshOwnerButton(); push("state.changed", new JSONObject());
                    })).show());
        });
        router.register("owner.setup.face", (message, reply) -> openOwnerProfileSetup(true, reply));
        router.register("owner.setup.voice", (message, reply) -> openOwnerProfileSetup(false, reply));
        router.register("owner.setup.presence", (message, reply) -> openOwnerProfileSetup(true, reply));

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

    private void beginOwnerMigration(com.patel5600.missminute.mobile.bridge.Handler.Reply reply) {
        String sessionId = OwnerAuthority.ownerSessionForCapability("memory.private.write");
        if (sessionId == null || !OwnerAuthority.authorizeOwnerCapability(sessionId, "memory.private.read")) {
            reply.fail("owner_auth_required", "Verify the owner before moving saved data.");
            return;
        }
        if (migrationReply != null) {
            reply.fail("unavailable", "Saved data migration is already running.");
            return;
        }
        migrationReply = reply;
        migrationSessionId = sessionId;
        migrationCommandPending = true;
        long generation = ++migrationGeneration;
        ownerSessionHandler.removeCallbacks(migrationTimeout);
        ownerSessionHandler.postDelayed(migrationTimeout, 30_000L);
        ensureMigrationWeb(generation, sessionId);
        launchOwnerMigration(generation);
    }

    /** Creates the only WebView that can see the legacy IndexedDB, and gives it migration-only IPC. */
    private void ensureMigrationWeb(long generation, String sessionId) {
        if (migrationWeb != null || !OwnerAuthority.authorizeOwnerCapability(sessionId, "memory.private.write")) return;
        BridgeRouter router = new BridgeRouter(Role.MIGRATION);
        router.register("hello", new HelloHandler(Role.MIGRATION, null, () -> {
            runOnUiThread(() -> launchOwnerMigration(generation));
            return new JSONObject();
        }));
        OwnerDataHandlers.registerMigration(router, this, sessionId);
        router.register("owner.migration.progress", (message, reply) -> {
            if (generation != migrationGeneration) {
                reply.fail("cancelled", "This migration request is no longer active.");
                return;
            }
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "memory.private.write")) {
                reply.fail("owner_auth_required", "Owner verification expired during migration.");
                return;
            }
            String stage = message.payload.optString("stage", "copying");
            if (!"checking".equals(stage) && !"copying".equals(stage)
                    && !"securing".equals(stage) && !"complete".equals(stage)) {
                reply.fail("bad_payload", "Invalid migration progress stage.");
                return;
            }
            JSONObject progress = new JSONObject().put("stage", stage)
                    .put("copied", Math.max(0, message.payload.optInt("copied", 0)));
            String store = message.payload.optString("store", "");
            if (store.matches("[a-z]{1,16}")) progress.put("store", store);
            push("owner.migration.progress", progress);
            ownerSessionHandler.removeCallbacks(migrationTimeout);
            ownerSessionHandler.postDelayed(migrationTimeout, 180_000L);
            reply.ok(new JSONObject());
        });
        router.register("owner.migration.complete", (message, reply) -> {
            if (generation != migrationGeneration) {
                reply.fail("cancelled", "This migration request is no longer active.");
                return;
            }
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "memory.private.write")) {
                reply.fail("owner_auth_required", "Owner verification expired during migration.");
                cancelOwnerMigration("Owner verification expired. Verify again to resume migration.");
                return;
            }
            boolean success = message.payload.optBoolean("success", false);
            String error = message.payload.optString("message", "Saved data could not be migrated.");
            if (success) {
                try {
                    JSONArray status = app.ownerDataDb().execute(new JSONObject().put("op", "migrationStatus"));
                    success = status.length() > 0 && status.optJSONObject(0) != null
                            && status.optJSONObject(0).optBoolean("done", false);
                    if (!success) error = "The encrypted store did not confirm migration completion; the browser copy was kept.";
                } catch (Exception e) {
                    success = false;
                    error = "The encrypted store could not verify migration completion; the browser copy was kept.";
                }
            }
            reply.ok(new JSONObject());
            final boolean migrationSucceeded = success;
            final String migrationResult = error;
            runOnUiThread(() -> finishOwnerMigration(generation, migrationSucceeded,
                    migrationSucceeded ? "Saved data is ready." : migrationResult));
        });

        migrationWeb = WebHost.create(this, Role.MIGRATION, router, reason ->
                finishOwnerMigration(generation, false, "The isolated migration page could not start."));
        if (migrationWeb.attachTo(migrationHolder, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) == null) {
            destroyMigrationWeb();
            finishOwnerMigration(generation, false, "This Android WebView cannot run the secure data migration.");
        }
    }

    private void launchOwnerMigration(long generation) {
        if (generation != migrationGeneration) return;
        if (!migrationCommandPending || migrationReply == null || migrationWeb == null
                || !migrationWeb.isPageConnected()) return;
        if (migrationSessionId == null
                || !OwnerAuthority.authorizeOwnerCapability(migrationSessionId, "memory.private.write")) {
            cancelOwnerMigration("Owner verification expired. Verify again to resume migration.");
            return;
        }
        migrationCommandPending = false;
        ownerSessionHandler.removeCallbacks(migrationTimeout);
        ownerSessionHandler.postDelayed(migrationTimeout, 180_000L);
        migrationWeb.send(Protocol.command("owner.migration.run", new JSONObject()));
    }

    private void finishOwnerMigration(long generation, boolean success, String result) {
        if (generation != migrationGeneration) return;
        String sessionId = migrationSessionId;
        if (success && (sessionId == null
                || !OwnerAuthority.authorizeOwnerCapability(sessionId, "memory.private.write"))) {
            finishOwnerMigration(false, "Owner verification expired. Verify again to resume migration.");
            return;
        }
        finishOwnerMigration(success, result);
    }

    private void finishOwnerMigration(boolean success, String result) {
        migrationGeneration++;
        migrationSessionId = null;
        ownerSessionHandler.removeCallbacks(migrationTimeout);
        migrationCommandPending = false;
        com.patel5600.missminute.mobile.bridge.Handler.Reply waiting = migrationReply;
        migrationReply = null;
        if (waiting != null) {
            if (success && OwnerAuthority.hasOwnerSession()) {
                waiting.ok(new JSONObject());
            } else {
                waiting.fail(OwnerAuthority.hasOwnerSession() ? "unavailable" : "owner_auth_required", result);
            }
        }
        destroyMigrationWeb();
    }

    private void cancelOwnerMigration(String reason) {
        if (migrationReply != null) finishOwnerMigration(false, reason);
        else {
            migrationGeneration++;
            destroyMigrationWeb();
        }
    }

    private void destroyMigrationWeb() {
        if (migrationWeb != null) {
            migrationWeb.destroy();
            migrationWeb = null;
        }
        if (migrationHolder != null) migrationHolder.removeAllViews();
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
        JSONObject out = new JSONObject()
                .put("version", BuildConfig.VERSION_NAME)
                .put("sdk", Build.VERSION.SDK_INT)
                .put("ownerEnrolled", OwnerAuthority.isEnrolled(this))
                .put("ownerAuthenticated", OwnerAuthority.hasOwnerSession())
                .put("ownerSessionId", OwnerAuthority.currentOwnerSessionId())
                .put("ownerCandidate", OwnerAuthority.isOwnerCandidate())
                .put("authState", OwnerAuthority.getAuthState())
                .put("faceProfileEnrolled", FaceProfileStore.exists(this))
                .put("faceProfilePending", FaceProfileStore.existsPending(this))
                .put("speakerProfileEnrolled", SpeakerIdentityEngine.hasProfile(this))
                .put("speakerProfilePending", SpeakerProfileStore.existsPending(this))
                .put("sensorConsentGiven", getSharedPreferences("owner_setup", MODE_PRIVATE).getBoolean("sensor_consent_v1", false))
                .put("ownerClaimPending", getSharedPreferences("owner_setup", MODE_PRIVATE).getBoolean("owner_claim_pending_v1", false))
                .put("overlay", OverlayHandlers.status(this, this));
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
        dashboardResumed = true;
        web.onResume();
        refreshHeader();
        refreshOwnerButton();
        push("state.changed", new JSONObject());
        scheduleOwnerSessionCheck();
    }

    @Override
    protected void onPause() {
        web.onPause(false);
        super.onPause();
    }

    @Override
    protected void onStop() {
        dashboardResumed = false;
        ownerSessionHandler.removeCallbacks(ownerSessionCheck);
        app.killSwitch().removeListener(killListener);
        if (runtimeRegistration != null) {
            runtimeRegistration.unregister();
            runtimeRegistration = null;
        }
        super.onStop();
    }

    static void onOwnerAppBackgrounded() {
        DashboardActivity dashboard = activeDashboard.get();
        if (dashboard != null) dashboard.cancelOwnerMigration("Miss Minutes was backgrounded. Verify again to resume migration.");
    }

    private void finishOwnerSetup(com.patel5600.missminute.mobile.bridge.Handler.Reply reply) {
        try {
            if (!OwnerAuthority.hasOwnerSession()) throw new SecurityException("Owner session was not established.");
            FaceProfileStore.activatePending(this);
            SpeakerProfileStore.activatePending(this);
            if (!getSharedPreferences("owner_setup", MODE_PRIVATE).edit()
                    .putBoolean("owner_claim_pending_v1", false).commit()) {
                throw new IllegalStateException("Could not commit owner setup completion.");
            }
            reply.ok(new JSONObject().put("authenticated", OwnerAuthority.hasOwnerSession())
                    .put("faceProfileEnrolled", FaceProfileStore.exists(this))
                    .put("speakerProfileEnrolled", SpeakerIdentityEngine.hasProfile(this)));
        } catch (Exception error) {
            OwnerAuthority.lock();
            reply.fail("internal", "Device verification succeeded, but staged recognition profiles could not be activated. Owner access remains locked.");
        }
    }

    private void openOwnerProfileSetup(boolean face, com.patel5600.missminute.mobile.bridge.Handler.Reply reply) {
        boolean pending = !OwnerAuthority.isEnrolled(this);
        if (!getSharedPreferences("owner_setup", MODE_PRIVATE).getBoolean("sensor_consent_v1", false)) {
            reply.fail("forbidden", "Review and accept the local sensor disclosure before opening enrollment.");
            return;
        }
        runOnUiThread(() -> {
            Intent intent = new Intent(this, face ? FacePresenceActivity.class : SpeakerIdentityActivity.class);
            if (pending) intent.putExtra(face ? FacePresenceActivity.EXTRA_PENDING_OWNER_ENROLLMENT
                    : SpeakerIdentityActivity.EXTRA_PENDING_OWNER_ENROLLMENT, true);
            startActivity(intent);
            try { reply.ok(new JSONObject().put("opened", face ? "face" : "voice")); }
            catch (JSONException error) { reply.fail("internal", "The setup screen opened, but its status could not be returned."); }
        });
    }

    private OwnerAuthority.Callback ownerCallback() {
        return (sessionId, error) -> runOnUiThread(() -> {
            refreshOwnerButton();
            push("state.changed", new JSONObject());
            if (error != null) {
                Toast.makeText(this, error, Toast.LENGTH_LONG).show();
            } else {
                scheduleOwnerSessionCheck();
                Toast.makeText(this,
                        "Owner verified. Private app data and configured owner controls are unlocked on this device.",
                        Toast.LENGTH_LONG).show();
            }
        });
    }

    private void refreshOwnerButton() {
        if (ownerButton == null) return;
        if (OwnerAuthority.hasOwnerSession()) {
            ownerButton.setText("Lock owner");
        } else {
            ownerButton.setText(OwnerAuthority.isEnrolled(this) ? "Unlock" : "Owner setup");
        }
    }

    private void scheduleOwnerSessionCheck() {
        ownerSessionHandler.removeCallbacks(ownerSessionCheck);
        if (dashboardResumed && OwnerAuthority.hasOwnerSession()) {
            ownerSessionHandler.postDelayed(ownerSessionCheck, OWNER_SESSION_CHECK_MS);
        }
    }

    @Override
    protected void onDestroy() {
        cancelOwnerMigration("The app closed before migration finished.");
        if (activeDashboard.get() == this) activeDashboard = new WeakReference<>(null);
        destroyMigrationWeb();
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

    @Override
    public void refreshOwnerControls() {
        runOnUiThread(() -> {
            refreshOwnerButton();
            refreshHeader();
            push("state.changed", new JSONObject());
            scheduleOwnerSessionCheck();
        });
    }
}
