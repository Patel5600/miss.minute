package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class FrameStatsTest {
    @Test
    public void reportsTheRateOverTheWindowAndStartsANewOne() {
        FrameStats stats = new FrameStats();
        long t = 10_000;
        for (int i = 0; i < 150; i++) {
            stats.onFrame(t + i * 33L);
        }
        assertFalse(stats.due(t + 4_000));
        assertTrue(stats.due(t + 5_000));
        double fps = stats.takeFps(t + 5_000);
        assertEquals(30.0, fps, 0.01);
        assertEquals(150, stats.totalFrames());
        assertFalse("a new window has started", stats.due(t + 5_001));
    }

    @Test
    public void nothingIsDueBeforeTheFirstFrame() {
        FrameStats stats = new FrameStats();
        assertFalse(stats.due(1_000_000));
        assertEquals(0.0, stats.takeFps(1_000_000), 0.0);
    }

    @Test
    public void restartingTheWindowKeepsTheTotalButDropsThePause() {
        FrameStats stats = new FrameStats();
        stats.onFrame(0);
        stats.onFrame(33);
        stats.restartWindow();
        assertFalse(stats.due(60_000));
        stats.onFrame(60_000);
        assertEquals(3, stats.totalFrames());
    }
}
