package com.patel5600.missminute.mobile.core.kill;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** What the kill switch left behind. Immutable. */
public final class KillState {
    public final boolean killed;
    public final long atMs;
    public final KillPath path;
    public final List<String> cancelled;
    /** The next launch shows a notice until the owner acknowledges it. */
    public final boolean noticePending;

    public KillState(boolean killed, long atMs, KillPath path, List<String> cancelled, boolean noticePending) {
        this.killed = killed;
        this.atMs = atMs;
        this.path = path;
        this.cancelled = Collections.unmodifiableList(new ArrayList<>(cancelled));
        this.noticePending = noticePending;
    }

    public static KillState notKilled() {
        return new KillState(false, 0, KillPath.EXTERNAL, Collections.<String>emptyList(), false);
    }

    /** Used when the stored state cannot be read: the safe reading is "killed". */
    public static KillState unreadable() {
        return new KillState(true, 0, KillPath.EXTERNAL, Collections.<String>emptyList(), true);
    }

    public KillState withNoticeAcknowledged() {
        return new KillState(killed, atMs, path, cancelled, false);
    }

    public String toJson() {
        try {
            return new JSONObject().put("killed", killed).put("atMs", atMs).put("path", path.wireName)
                    .put("cancelled", new JSONArray(cancelled)).put("noticePending", noticePending).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** @throws IllegalArgumentException when the text is not a valid state */
    public static KillState fromJson(String text) {
        try {
            JSONObject o = new JSONObject(text);
            KillPath path = KillPath.fromWire(o.getString("path"));
            if (path == null) {
                throw new IllegalArgumentException("unknown kill path");
            }
            JSONArray c = o.getJSONArray("cancelled");
            List<String> labels = new ArrayList<>();
            for (int i = 0; i < c.length(); i++) {
                labels.add(c.getString(i));
            }
            return new KillState(o.getBoolean("killed"), o.getLong("atMs"), path, labels, o.getBoolean("noticePending"));
        } catch (JSONException e) {
            throw new IllegalArgumentException("invalid kill state", e);
        }
    }
}