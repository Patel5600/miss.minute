package com.patel5600.missminute.mobile.core;

/**
 * Caps how often the companion loop does work. A Choreographer delivers a frame at every display
 * refresh, so the gate lets one through only after the capped interval has passed. It allows
 * {@link #TOLERANCE_MS} of slack: a 30 fps cap on a 60 Hz screen would otherwise land on every third
 * refresh (about 20 fps) whenever a frame time comes in a hair under 33.3 ms.
 */
public final class FrameGate {
    public static final long TOLERANCE_MS = 2;
    /** How long before the next allowed frame a delayed callback should wake up. */
    public static final long WAKE_EARLY_MS = 10;

    private int fps;
    private long lastAdmittedNanos;
    private boolean any;

    public void setFps(int fps) {
        this.fps = Math.max(0, fps);
    }

    public int fps() {
        return fps;
    }

    /** Forget the last frame, for example after the loop was paused. */
    public void reset() {
        any = false;
    }

    /** True when the frame at {@code frameTimeNanos} should do work. A cap of 0 never admits. */
    public boolean admit(long frameTimeNanos) {
        if (fps <= 0) {
            return false;
        }
        if (any) {
            long elapsedMs = (frameTimeNanos - lastAdmittedNanos) / 1_000_000L;
            if (elapsedMs < intervalMs() - TOLERANCE_MS) {
                return false;
            }
        }
        lastAdmittedNanos = frameTimeNanos;
        any = true;
        return true;
    }

    /**
     * How long to wait before asking the Choreographer for the next frame, so a low cap does not wake
     * the process at every display refresh. 0 means ask for the very next frame.
     */
    public long delayBeforeNextCallbackMs() {
        if (fps <= 0) {
            return 0;
        }
        return Math.max(0, intervalMs() - TOLERANCE_MS - WAKE_EARLY_MS);
    }

    private long intervalMs() {
        return 1000L / fps;
    }
}
