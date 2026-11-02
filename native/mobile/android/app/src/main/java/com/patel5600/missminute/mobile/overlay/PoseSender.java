package com.patel5600.missminute.mobile.overlay;

import com.patel5600.missminute.mobile.core.Locomotion;
import com.patel5600.missminute.mobile.core.OverlayState;
import com.patel5600.missminute.mobile.core.protocol.Protocol;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Builds the commands for the overlay page (rig.pose, rig.cue, rig.hop, rig.squash, rig.power,
 * rig.visible) and sends one only when it changed, so the page hears about a pose change and not about
 * every frame. No Android classes: the sink carries the text to the WebView.
 */
public final class PoseSender {
    public interface Sink {
        void send(String json);
    }

    private final Sink sink;
    private Locomotion lastLocomotion;
    private int lastFacing;
    private int lastSpeed = -1;
    private OverlayState lastState;
    private int lastFps = -1;
    private int lastVisible = -1;

    public PoseSender(Sink sink) {
        this.sink = sink;
    }

    /** Sends rig.pose when the locomotion, facing or rounded speed (px per second) changed. */
    public boolean pose(Locomotion locomotion, int facing, double speed) {
        int rounded = (int) Math.round(Math.max(0, speed));
        if (locomotion == lastLocomotion && facing == lastFacing && rounded == lastSpeed) {
            return false;
        }
        lastLocomotion = locomotion;
        lastFacing = facing;
        lastSpeed = rounded;
        sendPose();
        return true;
    }

    private void sendPose() {
        if (lastLocomotion != null) {
            emit("rig.pose", "locomotion", lastLocomotion.name(), "facing", lastFacing, "speed", lastSpeed);
        }
    }

    /** A gesture always plays, even the same one twice in a row. */
    public void gesture(String name) {
        emit("rig.cue", "gesture", name);
    }

    /** One of the 14 states; sent only when it changed. */
    public boolean state(OverlayState state) {
        if (state == lastState) {
            return false;
        }
        lastState = state;
        emit("rig.cue", "state", state.name());
        return true;
    }

    public void hop() {
        emit("rig.hop");
    }

    public void squash(double amount) {
        double clamped = Math.max(0, Math.min(1, amount));
        emit("rig.squash", "amount", Math.round(clamped * 100) / 100.0);
    }

    /** The page's frame cap; sent only when it changed. */
    public boolean power(int fps) {
        if (fps == lastFps) {
            return false;
        }
        lastFps = fps;
        emit("rig.power", "fps", fps);
        return true;
    }

    /** Whether the page should draw her; sent only when it changed. */
    public boolean visible(boolean visible) {
        int value = visible ? 1 : 0;
        if (value == lastVisible) {
            return false;
        }
        lastVisible = value;
        emit("rig.visible", "visible", visible);
        return true;
    }

    /** The page was reloaded: tell it everything it needs again. */
    public void resend() {
        if (lastFps >= 0) {
            emit("rig.power", "fps", lastFps);
        }
        if (lastVisible >= 0) {
            emit("rig.visible", "visible", lastVisible == 1);
        }
        if (lastState != null) {
            emit("rig.cue", "state", lastState.name());
        }
        sendPose();
    }

    /** {@code keysAndValues} alternate: a key, then its value. */
    private void emit(String type, Object... keysAndValues) {
        try {
            JSONObject payload = new JSONObject();
            for (int i = 0; i + 1 < keysAndValues.length; i += 2) {
                payload.put((String) keysAndValues[i], keysAndValues[i + 1]);
            }
            sink.send(Protocol.command(type, payload));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}
