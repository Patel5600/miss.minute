package com.patel5600.missminute.mobile.core;

/** The numbers from the plan's "Character box and physics" contract, all in dp and seconds. */
public final class PhysicsConfig {
    public final double gravity = 2600;
    public final double maxFallSpeed = 4500;
    public final double wallRestitution = 0.40;
    public final double floorRestitution = 0.18;
    public final double settleSpeed = 160;
    public final double floorFriction = 1800;
    public final double flingClamp = 5200;
    public final double throwThreshold = 450;
    public final double stepSeconds = 1.0 / 120.0;
    public final int maxStepsPerFrame = 8;
    public final double squashImpactFloor = 350;

    public static PhysicsConfig defaults() {
        return new PhysicsConfig();
    }

    /** Squash on landing: clamp((impact - 350) / 2000, 0.15, 1) when impact > 350, else 0. */
    public double squashFor(double impact) {
        if (impact <= squashImpactFloor) {
            return 0;
        }
        double s = (impact - squashImpactFloor) / 2000.0;
        return Math.max(0.15, Math.min(1.0, s));
    }
}