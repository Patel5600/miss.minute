package com.patel5600.missminute.mobile.core;

/** What the loop should do next. Positions are window-left x in dp. */
public final class BehaviourPlan {
    public final String behaviourId;
    public final Behaviour.Kind kind;
    public final double targetX;
    /** dp per second; 0 when she stays put. */
    public final double speed;
    public final long durationMs;
    /** Gesture name for gesture plans, else null. */
    public final String gesture;

    public BehaviourPlan(String behaviourId, Behaviour.Kind kind, double targetX, double speed,
                         long durationMs, String gesture) {
        this.behaviourId = behaviourId;
        this.kind = kind;
        this.targetX = targetX;
        this.speed = speed;
        this.durationMs = durationMs;
        this.gesture = gesture;
    }

    @Override
    public String toString() {
        return behaviourId + "|x=" + Math.round(targetX * 10) / 10.0 + "|v=" + Math.round(speed * 10) / 10.0
                + "|" + durationMs + "ms";
    }
}