package com.patel5600.missminute.mobile.bridge;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * Defense-in-depth boundary for bridge messages that read private state or can cause owner-side
 * effects. Handlers must still authorize their exact capability. Dashboard messages require a
 * live owner session by default; only explicitly listed bootstrap, status, and stop operations
 * can be reached while locked. Adding a new bridge command therefore fails closed.
 */
final class OwnerMessagePolicy {
    private static final Set<String> LOCKED_ALLOWED = Collections.unmodifiableSet(new HashSet<>(java.util.Arrays.asList(
            "hello",
            "owner.authenticate",
            "owner.setup.enroll",
            "owner.setup.consent",
            "owner.setup.face",
            "owner.setup.voice",
            "owner.setup.presence",
            "owner.identity.summary", // Handler verifies the owner session before returning identifiers.
            "owner.pairing.request.create", // Target key is device-bound and contains no owner data.
            "owner.pairing.receipt.import", // Handler verifies a signed receipt against this device's pending key.
            "owner.recovery.restore", // Requires the offline encrypted recovery proof and adds no session.
            "overlay.status",
            "overlay.stop",
            "kill.request",
            "kill.ackNotice",
            "provider.cancel",
            "provider.http.cancel",
            "provider.chatgpt.cancel",
            "voice.listen.stop",
            "voice.stop",
            "wake.stop",
            "calls.hangup",
            "owner.kill"
    )));

    private OwnerMessagePolicy() { }

    static boolean requiresOwnerSession(String type) {
        return !LOCKED_ALLOWED.contains(type);
    }
}
