package com.patel5600.missminute.mobile.core;

/** Worlds shared by the tests. */
public final class TestWorlds {
    private TestWorlds() {
    }

    /** A 412 x 915 dp phone in portrait: status bar 40, gesture bar 24, 24 dp back-gesture zones. */
    public static World portrait() {
        return new World(412, 915, 40, 24, 0, 0, 24, 24, 140, 2.625);
    }

    /** The same phone turned sideways. */
    public static World landscape() {
        return new World(915, 412, 24, 24, 0, 0, 24, 24, 140, 2.625);
    }
}