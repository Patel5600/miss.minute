package com.patel5600.missminute.mobile.core;

public enum Visibility {
    /** Drawn and roaming. */
    ACTIVE,
    /** Drawn at her docked spot, standing. */
    DOCKED,
    /** Drawn state kept but no animation work (screen off, lock screen). */
    PAUSED,
    /** Window removed from the screen. */
    HIDDEN
}