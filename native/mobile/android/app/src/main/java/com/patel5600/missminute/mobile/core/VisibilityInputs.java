package com.patel5600.missminute.mobile.core;

/** Everything that decides whether she is drawn. Immutable. */
public final class VisibilityInputs {
    public final boolean screenOn;
    public final boolean keyguardLocked;
    public final boolean fullscreenDetected;
    public final boolean userRoamingOff;
    public final long hiddenUntilMs;
    public final long nowMs;
    public final boolean quietHours;
    public final boolean focusMode;
    public final PowerTier batteryTier;

    public VisibilityInputs(boolean screenOn, boolean keyguardLocked, boolean fullscreenDetected,
                            boolean userRoamingOff, long hiddenUntilMs, long nowMs,
                            boolean quietHours, boolean focusMode, PowerTier batteryTier) {
        this.screenOn = screenOn;
        this.keyguardLocked = keyguardLocked;
        this.fullscreenDetected = fullscreenDetected;
        this.userRoamingOff = userRoamingOff;
        this.hiddenUntilMs = hiddenUntilMs;
        this.nowMs = nowMs;
        this.quietHours = quietHours;
        this.focusMode = focusMode;
        this.batteryTier = batteryTier;
    }
}