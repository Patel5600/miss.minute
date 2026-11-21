package com.patel5600.missminute.mobile.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class OwnerRecognitionPolicyTest {
    @Test
    public void recognizedOwnerReusesAnActiveSessionWithoutAnotherPrompt() {
        assertFalse(OwnerRecognitionPolicy.shouldRequestPlatformVerification(true));
    }

    @Test
    public void recognitionCandidateStillNeedsPlatformVerificationWhenLocked() {
        assertTrue(OwnerRecognitionPolicy.shouldRequestPlatformVerification(false));
    }
}
