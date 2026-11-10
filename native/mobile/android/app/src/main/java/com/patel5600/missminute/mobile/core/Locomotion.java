package com.patel5600.missminute.mobile.core;

/** What her body is doing. The names equal "locomotion" in tests/android/vectors/vocabulary.json. */
public enum Locomotion {
    STAND, WALK, RUN, SIT_EDGE, HANG, CLIMB, JUMP, FALL, PEEK, NAP, DRAGGED, THROWN, TELEPORT, THINK;

    /** True while gravity applies. */
    public boolean isAirborneKind() {
        return this == JUMP || this == FALL || this == THROWN;
    }

    /** True while she is in a special non-physics state. */
    public boolean isSpecialKind() {
        return this == TELEPORT || this == THINK;
    }
}