package com.patel5600.missminute.mobile.core;

/** What {@link PowerPolicy} allows right now. Immutable. */
public final class PowerDecision {
    /** 30, 15, 8 or 0 (paused). */
    public final int maxFps;
    public final RoamingLevel levelCap;
    public final boolean allowJumps;
    public final boolean allowRun;
    /** Multiplier for walking speed. */
    public final double speedScale;
    public final PowerTier tier;

    public PowerDecision(int maxFps, RoamingLevel levelCap, boolean allowJumps, boolean allowRun,
                         double speedScale, PowerTier tier) {
        this.maxFps = maxFps;
        this.levelCap = levelCap;
        this.allowJumps = allowJumps;
        this.allowRun = allowRun;
        this.speedScale = speedScale;
        this.tier = tier;
    }
}