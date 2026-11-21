package com.patel5600.missminute.mobile.bridge;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public final class OwnerMessagePolicyTest {
    @Test public void ownerRecoveryKitCreationRequiresAnActiveOwnerSession() {
        assertTrue(OwnerMessagePolicy.requiresOwnerSession("owner.recovery.create"));
    }

    @Test public void recoveryRestoreIsProofGatedInsteadOfRequiringAnExistingSession() {
        assertFalse(OwnerMessagePolicy.requiresOwnerSession("owner.recovery.restore"));
    }

    @Test public void futureToolExecutionHandlersFailClosedByDefault() {
        assertTrue(OwnerMessagePolicy.requiresOwnerSession("tool.execute"));
    }

    @Test public void onlyExplicitOnboardingRoutesMayStartWhileLocked() {
        assertFalse(OwnerMessagePolicy.requiresOwnerSession("owner.setup.enroll"));
        assertFalse(OwnerMessagePolicy.requiresOwnerSession("owner.setup.consent"));
        assertFalse(OwnerMessagePolicy.requiresOwnerSession("owner.setup.face"));
        assertFalse(OwnerMessagePolicy.requiresOwnerSession("owner.setup.voice"));
        assertFalse(OwnerMessagePolicy.requiresOwnerSession("owner.setup.presence"));
    }

    @Test public void everyDashboardAndUserOnlyMessageIsOwnerGatedUnlessExplicitlySafe() {
        Set<String> lockedAllowed = new HashSet<>(Arrays.asList(
                "hello", "owner.authenticate", "owner.setup.enroll", "owner.setup.consent",
                "owner.setup.face", "owner.setup.voice", "owner.setup.presence", "owner.identity.summary",
                "owner.pairing.request.create", "owner.pairing.receipt.import", "owner.recovery.restore",
                "overlay.status", "overlay.stop", "kill.request", "kill.ackNotice",
                "provider.cancel", "provider.http.cancel", "provider.chatgpt.cancel",
                "voice.listen.stop", "voice.stop", "wake.stop", "calls.hangup", "owner.kill"));
        for (java.util.Map.Entry<String, com.patel5600.missminute.mobile.core.protocol.Authority> entry
                : com.patel5600.missminute.mobile.core.protocol.MessageTypes.table().entrySet()) {
            if (entry.getValue() == com.patel5600.missminute.mobile.core.protocol.Authority.DASHBOARD
                    || entry.getValue() == com.patel5600.missminute.mobile.core.protocol.Authority.USER_ONLY) {
                assertEquals(entry.getKey(), !lockedAllowed.contains(entry.getKey()),
                        OwnerMessagePolicy.requiresOwnerSession(entry.getKey()));
            }
        }
    }
}
