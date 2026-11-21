package com.patel5600.missminute.mobile.app;

/** Requires repeated, fresh SFace evidence before attention can request device verification. */
final class FaceMatchConsensus {
    static final int REQUIRED_MATCHES = 2;
    private static final long MAX_GAP_MS = 1_500;
    private int consecutiveMatches;
    private long lastMatchAt = -1;
    private boolean candidateEmitted;

    synchronized boolean observe(double cosineSimilarity, long elapsedRealtimeMs) {
        if (!Double.isFinite(cosineSimilarity) || elapsedRealtimeMs < 0
                || cosineSimilarity < LocalFaceMatcher.SAME_FACE_THRESHOLD) {
            reset();
            return false;
        }
        if (lastMatchAt >= 0 && (elapsedRealtimeMs <= lastMatchAt
                || elapsedRealtimeMs - lastMatchAt > MAX_GAP_MS)) reset();
        lastMatchAt = elapsedRealtimeMs;
        consecutiveMatches++;
        if (!candidateEmitted && consecutiveMatches >= REQUIRED_MATCHES) {
            candidateEmitted = true;
            return true;
        }
        return false;
    }

    /** True while the recent frame window still supports the candidate, not only on first emission. */
    synchronized boolean isConfirmed(long elapsedRealtimeMs) {
        return candidateEmitted && consecutiveMatches >= REQUIRED_MATCHES && lastMatchAt >= 0
                && elapsedRealtimeMs >= lastMatchAt
                && elapsedRealtimeMs - lastMatchAt <= MAX_GAP_MS;
    }

    synchronized void reset() {
        consecutiveMatches = 0;
        lastMatchAt = -1;
        candidateEmitted = false;
    }
}
