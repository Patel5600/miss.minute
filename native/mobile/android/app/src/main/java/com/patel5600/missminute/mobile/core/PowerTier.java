package com.patel5600.missminute.mobile.core;

/** How hard she may work. */
public enum PowerTier {
    /** 30 fps, everything allowed. */
    ACTIVE,
    /** 15 fps, level capped at CALM, no jumps or runs. */
    REDUCED,
    /** 8 fps; used for a docked or minimal presence. */
    MINIMAL,
    /** No animation work at all. */
    PAUSED
}