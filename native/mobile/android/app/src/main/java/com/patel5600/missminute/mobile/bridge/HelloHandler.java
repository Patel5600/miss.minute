package com.patel5600.missminute.mobile.bridge;

import com.patel5600.missminute.mobile.core.Capabilities;
import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.core.protocol.Protocol;
import com.patel5600.missminute.mobile.core.protocol.Role;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The page introduces itself. The overlay page reports what its rig can draw; the dashboard gets the
 * current mode, kill notice and overlay state in the answer. The role comes from the WebView, not from
 * the message.
 */
public final class HelloHandler implements Handler {
    /** Called for the overlay page. Runs on the router's worker thread. */
    public interface OverlayListener {
        void onOverlayHello(Capabilities reported, double rigScale);
    }

    /** What the dashboard learns in the answer to its hello. */
    public interface DashboardInfo {
        JSONObject describe() throws JSONException;
    }

    static final int MAX_CAPABILITIES = 64;
    static final int MAX_NAME_LENGTH = 40;

    private final Role role;
    private final OverlayListener overlay;
    private final DashboardInfo dashboard;

    public HelloHandler(Role role, OverlayListener overlay, DashboardInfo dashboard) {
        this.role = role;
        this.overlay = overlay;
        this.dashboard = dashboard;
    }

    @Override
    public void handle(Message message, Reply reply) throws Exception {
        JSONObject out = new JSONObject()
                .put("protocol", Protocol.VERSION)
                .put("role", role == Role.OVERLAY ? "overlay" : "dashboard");
        if (role == Role.OVERLAY) {
            if (overlay != null) {
                double scale = message.payload.optDouble("rigScale", 0);
                overlay.onOverlayHello(parseCapabilities(message.payload.optJSONArray("capabilities")),
                        Double.isNaN(scale) || Double.isInfinite(scale) ? 0 : scale);
            }
        } else if (dashboard != null) {
            JSONObject info = dashboard.describe();
            Iterator<String> keys = info.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                out.put(key, info.get(key));
            }
        }
        reply.ok(out);
    }

    /** Keeps only strings that are capability names from the vocabulary; reads at most 64 entries. */
    static Capabilities parseCapabilities(JSONArray array) {
        List<String> names = new ArrayList<>();
        if (array != null) {
            for (int i = 0; i < array.length() && i < MAX_CAPABILITIES; i++) {
                Object item = array.opt(i);
                if (item instanceof String && ((String) item).length() <= MAX_NAME_LENGTH) {
                    names.add((String) item);
                }
            }
        }
        return Capabilities.of(names);
    }
}
