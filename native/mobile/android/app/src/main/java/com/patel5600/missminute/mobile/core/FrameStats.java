package com.patel5600.missminute.mobile.core;

/** Counts processed frames so the debug build can log the real frame rate every few seconds. */
public final class FrameStats {
    public static final long REPORT_EVERY_MS = 5000;

    private long windowStartMs = -1;
    private int windowFrames;
    private long totalFrames;

    /** Call once per processed frame. */
    public void onFrame(long nowMs) {
        if (windowStartMs < 0) {
            windowStartMs = nowMs;
        }
        windowFrames++;
        totalFrames++;
    }

    /** True when at least {@link #REPORT_EVERY_MS} have passed since the window started. */
    public boolean due(long nowMs) {
        return windowStartMs >= 0 && nowMs - windowStartMs >= REPORT_EVERY_MS;
    }

    /** Frames per second over the current window; starts a new window. */
    public double takeFps(long nowMs) {
        if (windowStartMs < 0 || nowMs <= windowStartMs) {
            return 0;
        }
        double fps = windowFrames * 1000.0 / (nowMs - windowStartMs);
        windowStartMs = nowMs;
        windowFrames = 0;
        return fps;
    }

    public long totalFrames() {
        return totalFrames;
    }

    /** Forget the open window, for example after a pause, so the pause does not count as slow frames. */
    public void restartWindow() {
        windowStartMs = -1;
        windowFrames = 0;
    }
}
