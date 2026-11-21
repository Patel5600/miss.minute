package com.patel5600.missminute.mobile.core.policy;

import java.util.Collections;
import java.util.EnumSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** The owner's permission choices. Immutable. */
public final class PermissionState {
    public final Mode mode;
    public final Set<Capability> grants;
    public final boolean proactive;
    /** May system context (apps, battery) go to remote models? Off by default. */
    public final boolean shareWithRemote;

    public PermissionState(Mode mode, Set<Capability> grants, boolean proactive, boolean shareWithRemote) {
        this.mode = mode;
        EnumSet<Capability> copy = EnumSet.noneOf(Capability.class);
        copy.addAll(grants);
        this.grants = Collections.unmodifiableSet(copy);
        this.proactive = proactive;
        this.shareWithRemote = shareWithRemote;
    }

    /** First run: Suggest, nothing granted, no proactive reactions. */
    public static PermissionState defaults() {
        return new PermissionState(Mode.SUGGEST, EnumSet.noneOf(Capability.class), false, false);
    }

    /** The safe fallback when stored state cannot be read. */
    public static PermissionState observeOnly() {
        return new PermissionState(Mode.OBSERVE, EnumSet.noneOf(Capability.class), false, false);
    }

    public boolean isGranted(Capability c) {
        return grants.contains(c);
    }

    public PermissionState withMode(Mode m) {
        return new PermissionState(m, grants, proactive, shareWithRemote);
    }

    public PermissionState withGrant(Capability c, boolean granted) {
        EnumSet<Capability> next = EnumSet.noneOf(Capability.class);
        next.addAll(grants);
        if (granted) {
            next.add(c);
        } else {
            next.remove(c);
        }
        return new PermissionState(mode, next, proactive, shareWithRemote);
    }

    public PermissionState withProactive(boolean p) {
        return new PermissionState(mode, grants, p, shareWithRemote);
    }

    public PermissionState withShareWithRemote(boolean s) {
        return new PermissionState(mode, grants, proactive, s);
    }

    public String toJson() {
        try {
            JSONArray g = new JSONArray();
            for (Capability c : grants) {
                g.put(c.wireName);
            }
            return new JSONObject().put("mode", mode.name()).put("grants", g).put("proactive", proactive)
                    .put("shareWithRemote", shareWithRemote).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** @throws IllegalArgumentException when the text is not a valid state */
    public static PermissionState fromJson(String text) {
        try {
            JSONObject o = new JSONObject(text);
            Mode mode = Mode.valueOf(o.getString("mode"));
            EnumSet<Capability> grants = EnumSet.noneOf(Capability.class);
            JSONArray g = o.getJSONArray("grants");
            for (int i = 0; i < g.length(); i++) {
                Capability c = Capability.fromWire(g.getString(i));
                if (c == null) {
                    throw new IllegalArgumentException("unknown capability");
                }
                grants.add(c);
            }
            return new PermissionState(mode, grants, o.getBoolean("proactive"), o.getBoolean("shareWithRemote"));
        } catch (JSONException e) {
            throw new IllegalArgumentException("invalid permission state", e);
        }
    }
}