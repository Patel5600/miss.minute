package com.patel5600.missminute.mobile.app;

import android.Manifest;
import android.app.Activity;
import android.os.Bundle;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.overlay.OverlayService;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Visible foreground-only owner voice enrollment and candidate check. */
public final class SpeakerIdentityActivity extends Activity {
    static final String EXTRA_PENDING_OWNER_ENROLLMENT = "com.patel5600.missminute.pending-owner-enrollment";
    private static final int REQUEST_MICROPHONE = 7341;
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "mm-speaker-verification");
        thread.setDaemon(true);
        return thread;
    });
    private TextView status;
    private Button enroll;
    private Button check;
    private Button delete;
    private Button close;
    private Button pendingPermissionAction;
    private boolean pendingOwnerEnrollment;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pendingOwnerEnrollment = getIntent().getBooleanExtra(EXTRA_PENDING_OWNER_ENROLLMENT, false)
                && !OwnerAuthority.isEnrolled(this);
        buildView();
        refresh();
    }

    @Override protected void onStart() {
        super.onStart();
        OverlayService.setDashboardForeground(this, true);
    }

    @Override protected void onStop() {
        OverlayService.setDashboardForeground(this, false);
        super.onStop();
    }

    private void buildView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(20), dp(16), dp(20), dp(20));
        root.setBackgroundColor(getColor(R.color.mm_base));

        TextView title = new TextView(this);
        title.setText("Owner voice profile");
        title.setTextColor(getColor(R.color.mm_face));
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView explanation = new TextView(this);
        explanation.setText(pendingOwnerEnrollment
                ? "Three short samples create an encrypted, staged speaker profile on this device. It cannot be used for matching until your device identity is verified at the end of setup. Recordings are discarded after local processing."
                : "Three short samples create an encrypted, device-local speaker template. A match can prepare an owner candidate and request Android verification; it never unlocks private data or grants authority by itself. Recordings are discarded after local matching. This check is not replay-proof.");
        explanation.setTextColor(getColor(R.color.mm_cream));
        explanation.setTextSize(15);
        explanation.setPadding(0, dp(8), 0, dp(16));
        root.addView(explanation, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        enroll = button("Enroll owner voice", root, this::requestEnrollment);
        check = button("Check voice candidate", root, this::requestMatch);
        delete = button("Delete voice profile", root, this::requestDelete);

        status = new TextView(this);
        status.setTextColor(getColor(R.color.mm_cream));
        status.setTextSize(15);
        status.setGravity(Gravity.CENTER_VERTICAL);
        status.setPadding(0, dp(16), 0, dp(16));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        root.addView(status, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        close = button("Close", root, this::finish);
        close.setTextColor(Color.WHITE);
        setContentView(root);
    }

    private Button button(String label, LinearLayout root, Runnable action) {
        Button result = new Button(this);
        result.setText(label);
        result.setAllCaps(false);
        result.setMinHeight(dp(48));
        result.setOnClickListener(view -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(6);
        root.addView(result, params);
        return result;
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void refresh() {
        boolean profile = SpeakerIdentityEngine.hasProfile(this);
        boolean pending = pendingOwnerEnrollment && SpeakerProfileStore.existsPending(this);
        check.setEnabled(profile && !SpeakerIdentityEngine.isBusy());
        delete.setEnabled(profile && !SpeakerIdentityEngine.isBusy());
        enroll.setEnabled(!SpeakerIdentityEngine.isBusy());
        enroll.setText(pending ? "Replace staged voice profile" : "Enroll owner voice");
        status.setText(profile ? "A local encrypted voice profile is enrolled. Voice match only requests device verification."
                : pending ? "A staged voice profile is encrypted locally and inactive until device verification completes."
                : "No voice profile is enrolled. Camera and microphone are used only after you start the corresponding feature.");
    }

    private void requestEnrollment() {
        if (ensureMicrophonePermission(enroll)) return;
        if (pendingOwnerEnrollment) {
            runOperation("Loading the local speaker model…", () -> SpeakerIdentityEngine.enrollPending(this,
                    message -> runOnUiThread(() -> show(message))), "Encrypted speaker profile staged. It will activate after device verification.");
            return;
        }
        if (OwnerAuthority.hasOwnerSession() && !OwnerAuthority.requireFreshAuthentication()) {
            show("Could not request fresh device verification. The voice profile was not changed.");
            return;
        }
        OwnerAuthority.authenticate(this, (session, error) -> runOnUiThread(() -> {
            if (error != null || session == null || !OwnerAuthority.authorizeOwnerCapability("owner.profile.modify")) {
                show("Owner authentication or profile permission was not granted.");
                return;
            }
            runOperation("Loading the local speaker model…", () -> SpeakerIdentityEngine.enroll(this,
                    message -> runOnUiThread(() -> show(message))), "Voice profile enrolled on this device.");
        }));
    }

    private void requestMatch() {
        if (ensureMicrophonePermission(check)) return;
        runOperation("Loading the local speaker model…", () -> {
            float score = SpeakerIdentityEngine.matchScore(this, message -> runOnUiThread(() -> show(message)));
            boolean matched = score >= SpeakerIdentityEngine.INITIAL_CANDIDATE_THRESHOLD;
            if (!matched) {
                runOnUiThread(() -> show("Voice did not match the local profile. Owner access remains locked."));
                return;
            }
            if (!OwnerRecognitionPolicy.shouldRequestPlatformVerification(OwnerAuthority.hasOwnerSession())) {
                runOnUiThread(() -> show("Enrolled owner voice recognized. The active owner session is still valid; no second device prompt was needed."));
                return;
            }
            if (!OwnerAuthority.reportVoiceMatch(SpeakerIdentityEngine.normalizedConfidence(score))) {
                runOnUiThread(() -> show("Voice matched locally, but the owner candidate state was rejected."));
                return;
            }
            runOnUiThread(() -> {
                show("Likely owner voice detected. Confirm with this device to unlock owner access.");
                OwnerAuthority.authenticate(this, (session, error) -> runOnUiThread(() -> {
                    if (error != null || session == null) show("Device verification did not complete. Owner access remains locked.");
                    else show("Device verified. Owner session is active.");
                    refresh();
                }));
            });
        }, null);
    }

    private void requestDelete() {
        if (OwnerAuthority.hasOwnerSession() && !OwnerAuthority.requireFreshAuthentication()) {
            show("Could not request fresh device verification. The voice profile was not deleted.");
            return;
        }
        OwnerAuthority.authenticate(this, (session, error) -> runOnUiThread(() -> {
            if (error != null || session == null || !OwnerAuthority.authorizeOwnerCapability("owner.profile.modify")) {
                show("Owner authentication or profile permission was not granted.");
                return;
            }
            WORKER.execute(() -> {
                try {
                    SpeakerIdentityEngine.deleteProfile(getApplicationContext());
                    runOnUiThread(() -> { show("Encrypted voice profile deleted."); refresh(); });
                } catch (Exception failure) {
                    runOnUiThread(() -> show("Could not delete the profile: " + failure.getMessage()));
                }
            });
        }));
    }

    private boolean ensureMicrophonePermission(Button action) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return false;
        pendingPermissionAction = action;
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MICROPHONE);
        show("Microphone permission is needed only for the voice action you selected.");
        return true;
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQUEST_MICROPHONE) return;
        Button action = pendingPermissionAction;
        pendingPermissionAction = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && action != null) action.performClick();
        else show("Microphone permission was denied. No audio was captured.");
    }

    private interface Operation { void run() throws Exception; }

    private void runOperation(String initial, Operation operation, String success) {
        if (SpeakerIdentityEngine.isBusy()) { show("A speaker operation is already running."); return; }
        setBusy(true, initial);
        WORKER.execute(() -> {
            try {
                operation.run();
                runOnUiThread(() -> { setBusy(false, success == null ? status.getText().toString() : success); refresh(); });
            } catch (Exception failure) {
                runOnUiThread(() -> { setBusy(false, "Voice operation failed: " + failure.getMessage()); refresh(); });
            }
        });
    }

    private void setBusy(boolean busy, String message) {
        enroll.setEnabled(!busy);
        check.setEnabled(!busy && SpeakerIdentityEngine.hasProfile(this));
        delete.setEnabled(!busy && SpeakerIdentityEngine.hasProfile(this));
        close.setEnabled(!busy);
        show(message);
    }

    private void show(String message) { if (status != null) status.setText(message); }

    @Override protected void onDestroy() {
        if (isFinishing() && !SpeakerIdentityEngine.isBusy()) SpeakerIdentityEngine.release();
        super.onDestroy();
    }

    @Override @SuppressWarnings("deprecation") public void onBackPressed() {
        if (SpeakerIdentityEngine.isBusy()) {
            show("Keep this screen open until local voice processing finishes.");
            return;
        }
        super.onBackPressed();
    }
}
