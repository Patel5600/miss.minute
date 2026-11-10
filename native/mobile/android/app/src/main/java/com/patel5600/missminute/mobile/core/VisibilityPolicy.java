package com.patel5600.missminute.mobile.core;

/**
 * Priority, highest first: a detected full-screen app or quiet hours (HIDDEN, even with the screen
 * off); screen off or lock screen (PAUSED); focus mode, "hide until" and a battery under 10%
 * (HIDDEN); roaming turned off (DOCKED); otherwise ACTIVE.
 */
public final class VisibilityPolicy {
    private VisibilityPolicy() {
    }

    public static Visibility decide(VisibilityInputs in) {
        if (in.fullscreenDetected || in.quietHours) {
            return Visibility.HIDDEN;
        }
        if (!in.screenOn || in.keyguardLocked) {
            return Visibility.PAUSED;
        }
        if (in.focusMode || in.nowMs < in.hiddenUntilMs || in.batteryTier == PowerTier.PAUSED) {
            return Visibility.HIDDEN;
        }
        if (in.userRoamingOff) {
            return Visibility.DOCKED;
        }
        return Visibility.ACTIVE;
    }
}