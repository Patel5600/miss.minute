package com.patel5600.missminute.mobile.app_world.behaviour;

import android.util.Log;

/**
 * Pure Event Sink for the autonomous companion.
 * Satisfies the Event-Driven Behaviour Contract:
 * - Decoupled from the rendering clock.
 * - Zero periodic timers: no timer or interval can force an autonomous action.
 * - Triggers decision evaluations ONLY upon discrete real-world and device events.
 */
public final class EventRouter {
    private static final String TAG = "MMEventRouter";

    public enum EventType {
        ACTION_COMPLETED,
        FOREGROUND_APP_CHANGED,
        LAUNCHER_PAGE_CHANGED,
        USER_TOUCH,
        SCREEN_WAKE,
        SCREEN_UNLOCK,
        SPATIAL_ANCHORS_UPDATED
    }

    public static final class DeviceEvent {
        public final EventType type;
        public final String stringData;
        public final int intData;
        public final long timestampMs;

        public DeviceEvent(EventType type, String stringData, int intData, long timestampMs) {
            this.type = type;
            this.stringData = stringData;
            this.intData = intData;
            this.timestampMs = timestampMs;
        }

        public static DeviceEvent actionCompleted(long nowMs) {
            return new DeviceEvent(EventType.ACTION_COMPLETED, null, 0, nowMs);
        }

        public static DeviceEvent foregroundChanged(String packageName, long nowMs) {
            return new DeviceEvent(EventType.FOREGROUND_APP_CHANGED, packageName, 0, nowMs);
        }

        public static DeviceEvent pageChanged(int pageIndex, long nowMs) {
            return new DeviceEvent(EventType.LAUNCHER_PAGE_CHANGED, null, pageIndex, nowMs);
        }

        public static DeviceEvent userTouch(String touchKind, long nowMs) {
            return new DeviceEvent(EventType.USER_TOUCH, touchKind, 0, nowMs);
        }

        public static DeviceEvent screenWake(long nowMs) {
            return new DeviceEvent(EventType.SCREEN_WAKE, null, 0, nowMs);
        }

        public static DeviceEvent screenUnlock(long nowMs) {
            return new DeviceEvent(EventType.SCREEN_UNLOCK, null, 0, nowMs);
        }

        public static DeviceEvent anchorsUpdated(long nowMs) {
            return new DeviceEvent(EventType.SPATIAL_ANCHORS_UPDATED, null, 0, nowMs);
        }
    }

    public interface Listener {
        void onEvent(DeviceEvent event);
    }

    private Listener listener;

    public EventRouter() {
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public void dispatch(DeviceEvent event) {
        if (event == null) return;
        Log.d(TAG, "Event dispatched: " + event.type + " data=" + event.stringData + " int=" + event.intData);
        if (listener != null) {
            listener.onEvent(event);
        }
    }
}
