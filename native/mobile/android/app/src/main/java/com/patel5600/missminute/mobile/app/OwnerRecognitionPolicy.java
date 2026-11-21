package com.patel5600.missminute.mobile.app;

/** Keeps recognition separate from authentication while avoiding duplicate prompts in an active session. */
final class OwnerRecognitionPolicy {
    private OwnerRecognitionPolicy() {}

    /** Call only after a local face or speaker match. A match never creates a session. */
    static boolean shouldRequestPlatformVerification(boolean ownerSessionActive) {
        return !ownerSessionActive;
    }
}
