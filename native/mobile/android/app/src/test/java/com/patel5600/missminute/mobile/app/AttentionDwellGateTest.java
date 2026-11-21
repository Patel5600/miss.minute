package com.patel5600.missminute.mobile.app;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class AttentionDwellGateTest {
    private static boolean attentive(AttentionDwellGate gate, long time) {
        return gate.observe(true, 0.9f, 0.9f, 2f, -3f, time);
    }

    @Test public void requiresStableAttentionAndDwellBeforeRequestingAuthentication() {
        AttentionDwellGate gate = new AttentionDwellGate();
        assertFalse(attentive(gate, 1_000));
        assertFalse(attentive(gate, 1_250));
        assertFalse(attentive(gate, 1_500));
        assertFalse(attentive(gate, 1_750));
        assertFalse(attentive(gate, 2_000));
        assertTrue(attentive(gate, 2_250));
        assertFalse(attentive(gate, 2_500)); // one activation per dwell
    }

    @Test public void blinkHeadTurnUnstableFaceAndFrameGapResetDwell() {
        AttentionDwellGate gate = new AttentionDwellGate();
        assertFalse(attentive(gate, 0));
        assertFalse(gate.observe(true, 0.2f, 0.9f, 0f, 0f, 250));
        assertFalse(attentive(gate, 500));
        assertFalse(gate.observe(true, 0.9f, 0.9f, 25f, 0f, 750));
        assertFalse(attentive(gate, 1_000));
        assertFalse(attentive(gate, 2_000)); // missed frames cannot count as continuous dwell
        assertFalse(attentive(gate, 2_250));
        assertFalse(attentive(gate, 2_500));
        assertFalse(attentive(gate, 2_750));
        assertFalse(attentive(gate, 3_000));
        assertTrue(attentive(gate, 3_250));
    }

    @Test public void unknownEyeClassificationNeverTriggers() {
        AttentionDwellGate gate = new AttentionDwellGate();
        for (long time = 0; time <= 2_000; time += 250) {
            assertFalse(gate.observe(true, null, null, 0f, 0f, time));
        }
    }
}
