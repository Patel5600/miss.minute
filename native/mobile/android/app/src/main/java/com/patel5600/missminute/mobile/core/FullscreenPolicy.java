package com.patel5600.missminute.mobile.core;

/**
 * Pure fullscreen detection policy used to pause or hide the floating companion when a video or
 * game hides system bars and the user enabled {@code hide_in_fullscreen}.
 */
public final class FullscreenPolicy {
    private FullscreenPolicy() {
    }

    public static boolean isFullscreenActive(
            boolean hideInFullscreenSetting,
            boolean dashboardForeground,
            boolean launcherKnownInForeground,
            boolean statusBarVisible) {
        if (!hideInFullscreenSetting || dashboardForeground || launcherKnownInForeground) {
            return false;
        }
        return !statusBarVisible;
    }
}
