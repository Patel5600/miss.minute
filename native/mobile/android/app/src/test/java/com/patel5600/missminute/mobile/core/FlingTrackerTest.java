package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class FlingTrackerTest {
    /** A finger moving at a steady speed: one sample every 8 ms (a 120 Hz screen). */
    private static FlingTracker steady(double pxPerSecX, double pxPerSecY, int samples) {
        FlingTracker tracker = new FlingTracker();
        for (int i = 0; i < samples; i++) {
            long t = 1000 + i * 8L;
            tracker.add(t, 500 + pxPerSecX * (i * 8L) / 1000.0, 900 + pxPerSecY * (i * 8L) / 1000.0);
        }
        return tracker;
    }

    @Test
    public void steadyMotionGivesThatVelocity() {
        FlingTracker tracker = steady(2000, -3500, 10);
        long release = 1000 + 9 * 8L;
        double[] v = tracker.velocity(release);
        assertEquals(2000, v[0], 1.0);
        assertEquals(-3500, v[1], 1.0);
    }

    @Test
    public void thePageOfTheWindowMovingWithTheFingerDoesNotMatterBecauseTheInputIsScreenPosition() {
        // The same finger path, seen only as screen coordinates, whatever the window does.
        FlingTracker tracker = steady(-1200, 0, 8);
        double[] v = tracker.velocity(1000 + 7 * 8L);
        assertEquals(-1200, v[0], 1.0);
        assertEquals(0, v[1], 1e-6);
    }

    @Test
    public void aFingerThatStoppedBeforeTheReleaseHasNoVelocity() {
        FlingTracker tracker = steady(3000, 0, 10);
        long last = 1000 + 9 * 8L;
        assertEquals(3000, tracker.velocity(last + FlingTracker.STOPPED_MS)[0], 1.0);
        double[] stopped = tracker.velocity(last + FlingTracker.STOPPED_MS + 1);
        assertEquals(0, stopped[0], 0.0);
        assertEquals(0, stopped[1], 0.0);
    }

    @Test
    public void samplesOlderThanTheHorizonAreIgnored() {
        FlingTracker tracker = new FlingTracker();
        // Fast to begin with (4000 px/s for 200 ms), then slow (500 px/s for the last 100 ms).
        for (int i = 0; i <= 25; i++) {
            tracker.add(1000 + i * 8L, 100 + 4000 * (i * 8L) / 1000.0, 0);
        }
        double xAtSwitch = 100 + 4000 * 200 / 1000.0;
        for (int i = 1; i <= 13; i++) {
            tracker.add(1200 + i * 8L, xAtSwitch + 500 * (i * 8L) / 1000.0, 0);
        }
        double[] v = tracker.velocity(1200 + 13 * 8L);
        assertEquals("only the slow last 100 ms counts", 500, v[0], 25);
    }

    @Test
    public void oneSampleIsNoVelocity() {
        FlingTracker tracker = new FlingTracker();
        tracker.add(1000, 10, 10);
        assertEquals(0, tracker.velocity(1010)[0], 0.0);
        assertEquals(0, new FlingTracker().velocity(0)[1], 0.0);
    }

    @Test
    public void samplesAtTheSameInstantAreNoVelocity() {
        FlingTracker tracker = new FlingTracker();
        tracker.add(1000, 10, 10);
        tracker.add(1000, 500, 500);
        assertEquals(0, tracker.velocity(1000)[0], 0.0);
    }

    @Test
    public void clearForgetsEverything() {
        FlingTracker tracker = steady(2000, 2000, 10);
        tracker.clear();
        assertEquals(0, tracker.velocity(1072)[0], 0.0);
    }

    @Test
    public void moreSamplesThanTheBufferHoldKeepsTheNewest() {
        FlingTracker tracker = steady(1500, -800, 60);
        long release = 1000 + 59 * 8L;
        double[] v = tracker.velocity(release);
        assertEquals(1500, v[0], 1.0);
        assertEquals(-800, v[1], 1.0);
    }

    @Test
    public void aFastFlingIsAboveTheThrowThreshold() {
        // 40 px in 80 ms on a 2.625 density screen is 190 dp/s: a drop. 400 px in 80 ms is 1900 dp/s: a throw.
        PhysicsConfig config = PhysicsConfig.defaults();
        FlingTracker slow = steady(500, 0, 11);
        FlingTracker fast = steady(5000, 0, 11);
        double density = 2.625;
        assertTrue(slow.velocity(1080)[0] / density < config.throwThreshold);
        assertTrue(fast.velocity(1080)[0] / density >= config.throwThreshold);
    }
}
