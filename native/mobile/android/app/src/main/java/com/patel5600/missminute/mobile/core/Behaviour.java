package com.patel5600.missminute.mobile.core;

/** One thing she can do, with the rules for when the director may pick it. Immutable. */
public final class Behaviour {
    public enum Kind { STAND, GESTURE, HOP, WALK, RUN, SIT_EDGE, HANG, CLIMB, NAP, JUMP, PEEK, TELEPORT, THINK }

    public final String id;
    public final Kind kind;
    /** Capability name the rig must report, for example "walk" or "gesture:wave". */
    public final String requires;
    public final RoamingLevel minLevel;
    public final double weight;
    public final long cooldownMs;
    public final long minDurationMs;
    public final long maxDurationMs;
    /** Gesture name for GESTURE behaviours, else null. */
    public final String gesture;

    public Behaviour(String id, Kind kind, String requires, RoamingLevel minLevel, double weight,
                     long cooldownMs, long minDurationMs, long maxDurationMs, String gesture) {
        this.id = id;
        this.kind = kind;
        this.requires = requires;
        this.minLevel = minLevel;
        this.weight = weight;
        this.cooldownMs = cooldownMs;
        this.minDurationMs = minDurationMs;
        this.maxDurationMs = maxDurationMs;
        this.gesture = gesture;
    }
}