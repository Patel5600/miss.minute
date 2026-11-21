package com.patel5600.missminute.mobile.app;

/**
 * Conservative hands-free attention trigger. This is a UI interaction signal, not gaze
 * estimation, face identity, liveness proof, or authentication. Callers must still require the
 * platform authenticator before granting owner access.
 */
final class AttentionDwellGate {
    static final long REQUIRED_DWELL_MS = 1_200;
    private static final long MAX_FRAME_GAP_MS = 700;
    private static final int MIN_OBSERVATIONS = 4;
    private long startedAt = -1;
    private long lastAt = -1;
    private int observations;
    private boolean fired;

    synchronized boolean observe(boolean stableFace, Float leftEyeOpen, Float rightEyeOpen,
            float yawDegrees, float pitchDegrees, long elapsedRealtimeMs) {
        boolean attentive = stableFace
                && leftEyeOpen != null && rightEyeOpen != null
                && leftEyeOpen >= 0.60f && rightEyeOpen >= 0.60f
                && Math.abs(yawDegrees) <= 12f
                && Math.abs(pitchDegrees) <= 18f;
        if (!attentive || elapsedRealtimeMs < 0 || fired) {
            reset();
            return false;
        }
        if (lastAt >= 0 && (elapsedRealtimeMs <= lastAt
                || elapsedRealtimeMs - lastAt > MAX_FRAME_GAP_MS)) {
            reset();
        }
        if (startedAt < 0) startedAt = elapsedRealtimeMs;
        lastAt = elapsedRealtimeMs;
        observations++;
        if (observations >= MIN_OBSERVATIONS
                && elapsedRealtimeMs - startedAt >= REQUIRED_DWELL_MS) {
            fired = true;
            return true;
        }
        return false;
    }

    synchronized void reset() {
        startedAt = -1;
        lastAt = -1;
        observations = 0;
        fired = false;
    }
}
