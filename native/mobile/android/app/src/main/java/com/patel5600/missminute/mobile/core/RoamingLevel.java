package com.patel5600.missminute.mobile.core;

/** How much of the screen she may use. DOCKED stands still; WILD does everything the rig can draw. */
public enum RoamingLevel {
    DOCKED, CALM, LIVELY, WILD;

    public boolean atLeast(RoamingLevel other) {
        return ordinal() >= other.ordinal();
    }

    public static RoamingLevel min(RoamingLevel a, RoamingLevel b) {
        return a.ordinal() <= b.ordinal() ? a : b;
    }
}