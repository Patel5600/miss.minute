package com.patel5600.missminute.mobile.voice;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public final class OutboundCallGuardTest {
    private static final int DAYTIME_MIN = 11 * 60;

    private static List<OutboundCallGuard.Fact> validFacts() {
        return Collections.singletonList(new OutboundCallGuard.Fact(
                OutboundCallGuard.FactKind.BRIEF_TOPIC, "Confirm dentist appointment slot"));
    }

    @Test
    public void validatesStrictE164AndQuietHoursAndDncAndCap() {
        assertTrue(OutboundCallGuard.isValidE164("+12025550111"));
        assertFalse(OutboundCallGuard.isValidE164("2025550111"));
        assertFalse(OutboundCallGuard.isValidE164("+02025550111"));
        assertFalse(OutboundCallGuard.isValidE164("+123456"));

        OutboundCallGuard.Policy policy = OutboundCallGuard.Policy.defaults();
        OutboundCallGuard.Ledger ledger = new OutboundCallGuard.Ledger(
                new HashSet<>(Collections.singletonList("+12025550199")), 0);

        // Quiet hours (22:15) blocked
        try {
            OutboundCallGuard.prepare("+12025550111", "Alex", validFacts(),
                    OutboundCallGuard.BrandVoice.MISS_MINUTES_TVA, 22 * 60 + 15, policy, ledger, true);
            fail("Expected quiet hours block");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("Quiet hours"));
        }

        // DNC blocked
        try {
            OutboundCallGuard.prepare("+12025550199", "Alex", validFacts(),
                    OutboundCallGuard.BrandVoice.MISS_MINUTES_TVA, DAYTIME_MIN, policy, ledger, true);
            fail("Expected DNC block");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("Do-Not-Call"));
        }

        // Daily cap blocked
        OutboundCallGuard.Ledger capped = new OutboundCallGuard.Ledger(Collections.emptySet(), 5);
        try {
            OutboundCallGuard.prepare("+12025550111", "Alex", validFacts(),
                    OutboundCallGuard.BrandVoice.MISS_MINUTES_TVA, DAYTIME_MIN, policy, capped, true);
            fail("Expected daily cap block");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("cap"));
        }
    }

    @Test
    public void rejectsUnsafeFactsAndEnforcesDisclosureBeforeConnected() {
        OutboundCallGuard.Policy policy = OutboundCallGuard.Policy.defaults();
        OutboundCallGuard.Ledger ledger = new OutboundCallGuard.Ledger(Collections.emptySet(), 0);

        // Secret prefix or newline rejected in Fact
        try {
            OutboundCallGuard.prepare("+12025550111", "Alex",
                    Arrays.asList(new OutboundCallGuard.Fact(
                            OutboundCallGuard.FactKind.BRIEF_TOPIC, "Use sk-secret123")),
                    OutboundCallGuard.BrandVoice.MISS_MINUTES_TVA, DAYTIME_MIN, policy, ledger, true);
            fail("Expected secret-prefixed fact to be rejected");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("disallowed"));
        }

        // Owner confirmation required
        try {
            OutboundCallGuard.prepare("+12025550111", "Alex", validFacts(),
                    OutboundCallGuard.BrandVoice.MISS_MINUTES_TVA, DAYTIME_MIN, policy, ledger, false);
            fail("Expected owner confirmation requirement");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().contains("confirmation"));
        }

        // Mandatory disclosure state machine: VALIDATED -> DISCLOSED -> CONNECTED
        OutboundCallGuard.PreparedCall call = OutboundCallGuard.prepare(
                "+12025550111", "Alex", validFacts(),
                OutboundCallGuard.BrandVoice.MISS_MINUTES_TVA, DAYTIME_MIN, policy, ledger, true);
        assertEquals(OutboundCallGuard.BrandVoice.MISS_MINUTES_TVA, call.voice);
        assertTrue(call.disclosureOpening.contains("Miss Minutes"));
        assertTrue(call.disclosureOpening.contains("AI"));
        assertEquals(OutboundCallGuard.CallState.VALIDATED, call.state());
        try {
            call.markConnected();
            fail("Must not connect before disclosure");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("disclosure"));
        }
        call.markDisclosed();
        assertEquals(OutboundCallGuard.CallState.DISCLOSED, call.state());
        call.markConnected();
        assertEquals(OutboundCallGuard.CallState.CONNECTED, call.state());
        call.complete();
        assertEquals(OutboundCallGuard.CallState.COMPLETED, call.state());
    }
}
