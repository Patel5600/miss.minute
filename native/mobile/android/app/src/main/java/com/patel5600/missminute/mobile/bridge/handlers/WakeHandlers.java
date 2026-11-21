package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;

import com.patel5600.missminute.mobile.app.OwnerAuthority;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.voice.WakeWordForegroundService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;

/**
 * Dashboard bridge handlers for the user-controlled on-device wake-word listener and
 * multi-phrase detector ("Hey Miss Minutes", "Miss Minutes", "Hey Miss", "Hey Minute",
 * "Miss Minute", plus emergency stop phrases).
 */
public final class WakeHandlers {
    private static final String[] WAKE_PHRASES = {
            "hey miss minutes", "miss minutes", "hey miss", "hey minute", "miss minute", "wake up miss minutes"
    };
    private static final String[] STOP_PHRASES = {
            "miss minutes stop", "hey miss minutes stop", "miss minute stop", "emergency stop", "freeze timeline"
    };

    private WakeHandlers() {}

    public static void register(BridgeRouter router, Context context, UiBridge ui) {
        if (ui != null) {
            WakeWordForegroundService.setStateListener(payload -> ui.push("wake.state", payload));
        }

        router.register("wake.start", (message, reply) -> {
            if (!OwnerAuthority.authorizeOwnerCapability("device.control")) {
                reply.fail("owner_auth_required", "Unlock Miss Minutes before starting microphone wake detection.");
                return;
            }
            if (ui != null && !ui.hasRecordAudioPermission()) {
                ui.requestRecordAudioPermission();
                reply.fail("forbidden", "Grant microphone permission first, then tap start again.");
                return;
            }
            boolean started = WakeWordForegroundService.start(context);
            if (!started) {
                reply.fail("unavailable", "Could not start microphone wake-word service.");
                return;
            }
            reply.ok(new JSONObject().put("listening", true));
        });

        router.register("wake.stop", (message, reply) -> {
            WakeWordForegroundService.stop(context);
            reply.ok(new JSONObject().put("listening", false));
        });

        router.register("wake.status", (message, reply) -> {
            if (!OwnerAuthority.hasOwnerSession()) {
                reply.fail("owner_auth_required", "Unlock owner access to inspect wake listener telemetry.");
                return;
            }
            reply.ok(new JSONObject()
                    .put("listening", WakeWordForegroundService.isRunning())
                    .put("micPermission", ui != null && ui.hasRecordAudioPermission())
                    .put("mode", OwnerAuthority.getOperatingMode())
                    .put("phrases", new JSONArray(Arrays.asList(WAKE_PHRASES)))
                    .put("emergencyStops", new JSONArray(Arrays.asList(STOP_PHRASES))));
        });

        router.register("wake.feed", (message, reply) -> {
            if (!OwnerAuthority.authorizeOwnerCapability("device.control")) {
                reply.fail("owner_auth_required", "Unlock Miss Minutes before evaluating wake phrases.");
                return;
            }
            String transcript = message.payload.optString("transcript", "").trim();
            if (transcript.length() > 256) {
                reply.fail("bad_payload", "Transcript exceeds maximum wake phrase length.");
                return;
            }
            double confDouble = message.payload.optDouble("confidence", 0.0);
            if (!Double.isFinite(confDouble) || confDouble < 0.0 || confDouble > 1.0) {
                reply.fail("bad_payload", "Phrase confidence must be finite in [0, 1].");
                return;
            }
            float phraseConfidence = (float) confDouble;
            short[] speechEnergyFrame = new short[480];
            for (int i = 0; i < speechEnergyFrame.length; i++) {
                speechEnergyFrame[i] = (short) Math.round(Math.sin(i * 0.28) * 6000.0);
            }
            JSONObject result = WakeWordForegroundService.evaluateFrame(
                    context,
                    speechEnergyFrame,
                    transcript.isEmpty() ? null : transcript,
                    phraseConfidence);
            Arrays.fill(speechEnergyFrame, (short) 0);
            reply.ok(result);
        });
    }
}
