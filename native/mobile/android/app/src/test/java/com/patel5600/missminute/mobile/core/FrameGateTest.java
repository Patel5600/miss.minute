package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class FrameGateTest {
    /** Admitted frames in one second of display refreshes at {@code hz}, with optional timing jitter. */
    private static int admittedPerSecond(int cap, double hz, double jitterMs) {
        FrameGate gate = new FrameGate();
        gate.setFps(cap);
        double period = 1000.0 / hz;
        int admitted = 0;
        int frames = (int) Math.round(hz);
        for (int i = 0; i < frames; i++) {
            double jitter = (i % 2 == 0 ? -jitterMs : jitterMs);
            long nanos = Math.round((i * period + jitter) * 1_000_000.0);
            if (gate.admit(nanos)) {
                admitted++;
            }
        }
        return admitted;
    }

    @Test
    public void thirtyFpsOnA60HzScreenRunsEverySecondRefresh() {
        assertEquals(30, admittedPerSecond(30, 60, 0));
    }

    @Test
    public void jitterOfAFewHundredthsDoesNotDropThirtyFpsToTwenty() {
        // Frames that arrive 0.5 ms early or late would miss the exact 33.33 ms interval without the tolerance.
        assertEquals(30, admittedPerSecond(30, 60, 0.5));
        assertEquals(30, admittedPerSecond(30, 60, 1.2));
    }

    @Test
    public void thirtyFpsOnFasterScreensStaysNearThirtyAndNeverAbove() {
        for (double hz : new double[] {90, 120, 144}) {
            int admitted = admittedPerSecond(30, hz, 0);
            assertTrue(hz + " Hz gave " + admitted, admitted >= 25 && admitted <= 31);
        }
    }

    @Test
    public void fifteenFpsOnA60HzScreenRunsEveryFourthRefresh() {
        assertEquals(15, admittedPerSecond(15, 60, 0));
    }

    @Test
    public void eightFpsIsACeilingNotAFloor() {
        int admitted = admittedPerSecond(8, 60, 0);
        assertTrue("got " + admitted, admitted >= 6 && admitted <= 8);
    }

    @Test
    public void aCapOfZeroPausesEverything() {
        FrameGate gate = new FrameGate();
        gate.setFps(0);
        for (int i = 0; i < 100; i++) {
            assertFalse(gate.admit(i * 16_000_000L));
        }
        assertEquals(0, gate.delayBeforeNextCallbackMs());
    }

    @Test
    public void theFirstFrameAfterAResetIsAlwaysAdmitted() {
        FrameGate gate = new FrameGate();
        gate.setFps(8);
        assertTrue(gate.admit(1_000_000_000L));
        assertFalse(gate.admit(1_016_000_000L));
        gate.reset();
        assertTrue(gate.admit(1_016_000_000L));
    }

    @Test
    public void aLowCapWaitsBeforeAskingForTheNextFrame() {
        FrameGate gate = new FrameGate();
        gate.setFps(30);
        assertEquals(1000 / 30 - FrameGate.TOLERANCE_MS - FrameGate.WAKE_EARLY_MS, gate.delayBeforeNextCallbackMs());
        gate.setFps(8);
        assertEquals(1000 / 8 - FrameGate.TOLERANCE_MS - FrameGate.WAKE_EARLY_MS, gate.delayBeforeNextCallbackMs());
        gate.setFps(100);
        assertEquals("a fast cap just asks for the next refresh", 0, gate.delayBeforeNextCallbackMs());
    }

    @Test
    public void aNegativeCapCountsAsZero() {
        FrameGate gate = new FrameGate();
        gate.setFps(-5);
        assertEquals(0, gate.fps());
        assertFalse(gate.admit(0));
    }
}
