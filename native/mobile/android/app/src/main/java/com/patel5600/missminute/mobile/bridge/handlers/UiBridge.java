package com.patel5600.missminute.mobile.bridge.handlers;

import org.json.JSONObject;

/**
 * What the dashboard handlers need from the screen they run in: a native confirmation, the system
 * permission screens, and a way to push an event to the page. Implemented by the dashboard Activity.
 */
public interface UiBridge {
    /** Answer of a native confirmation. */
    interface Confirmed {
        /** Called exactly once on the main thread; true only when the owner tapped Allow. */
        void onResult(boolean allowed);
    }

    /** Runs {@code action} on the main thread. */
    void runOnUi(Runnable action);

    /** A native dialog. Loosening anything must go through this: a page cannot confirm for the owner. */
    void confirm(int titleRes, int messageRes, Confirmed result);

    /** Opens the system page where "Display over other apps" is granted. */
    void openOverlayPermissionScreen();

    /** Asks for the notification permission when Android 13 or later still needs it. */
    void requestNotificationPermission();

    boolean notificationsGranted();

    /** Opens the folder-metadata watcher screen. */
    void openMetadataWatcher();

    /** Pushes an event ({@code state.changed}, {@code kill.happened}) to the dashboard page. */
    void push(String eventName, JSONObject payload);
}
