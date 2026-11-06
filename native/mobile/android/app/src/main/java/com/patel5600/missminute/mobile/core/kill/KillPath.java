package com.patel5600.missminute.mobile.core.kill;

/** How the kill switch was triggered. Wire names equal "killPaths" in vocabulary.json. */
public enum KillPath {
    NOTIFICATION("notification"),
    APP_BUTTON("app-button"),
    OVERLAY_MENU("overlay-menu"),
    EXTERNAL("external");

    public final String wireName;

    KillPath(String wireName) {
        this.wireName = wireName;
    }

    public static KillPath fromWire(String name) {
        for (KillPath p : values()) {
            if (p.wireName.equals(name)) {
                return p;
            }
        }
        return null;
    }
}