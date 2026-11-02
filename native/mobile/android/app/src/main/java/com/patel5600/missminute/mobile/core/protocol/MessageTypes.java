package com.patel5600.missminute.mobile.core.protocol;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Every message type and who may send it. Equal to "messageTypes" in
 * tests/android/vectors/vocabulary.json. A key ending in ".*" covers every type with that prefix.
 */
public final class MessageTypes {
    private static final Map<String, Authority> TABLE;

    static {
        Map<String, Authority> t = new LinkedHashMap<>();
        t.put("hello", Authority.PAGE);
        t.put("reply", Authority.NATIVE_ONLY);
        t.put("event", Authority.NATIVE_ONLY);
        t.put("rig.pose", Authority.NATIVE_ONLY);
        t.put("rig.cue", Authority.NATIVE_ONLY);
        t.put("rig.speech", Authority.NATIVE_ONLY);
        t.put("rig.hop", Authority.NATIVE_ONLY);
        t.put("rig.squash", Authority.NATIVE_ONLY);
        t.put("rig.power", Authority.NATIVE_ONLY);
        t.put("rig.visible", Authority.NATIVE_ONLY);
        t.put("rig.error", Authority.OVERLAY);
        t.put("overlay.status", Authority.DASHBOARD);
        t.put("overlay.start", Authority.DASHBOARD);
        t.put("overlay.stop", Authority.DASHBOARD);
        t.put("overlay.requestPermission", Authority.DASHBOARD);
        t.put("settings.get", Authority.DASHBOARD);
        t.put("settings.set", Authority.DASHBOARD);
        t.put("app.openMetadataWatcher", Authority.DASHBOARD);
        t.put("kill.request", Authority.USER_ONLY);
        t.put("kill.ackNotice", Authority.USER_ONLY);
        t.put("permissions.get", Authority.USER_ONLY);
        t.put("permissions.setMode", Authority.USER_ONLY);
        t.put("permissions.grant", Authority.USER_ONLY);
        t.put("permissions.revoke", Authority.USER_ONLY);
        t.put("system.consent.get", Authority.DASHBOARD);
        t.put("system.consent.set", Authority.USER_ONLY);
        t.put("system.snapshot", Authority.DASHBOARD);
        t.put("system.forget", Authority.DASHBOARD);
        t.put("reminders.*", Authority.DASHBOARD);
        t.put("todos.*", Authority.DASHBOARD);
        t.put("notes.*", Authority.DASHBOARD);
        t.put("provider.status", Authority.DASHBOARD);
        t.put("provider.promptKey", Authority.USER_ONLY);
        t.put("provider.remove", Authority.USER_ONLY);
        t.put("provider.pair.start", Authority.USER_ONLY);
        t.put("provider.pair.complete", Authority.USER_ONLY);
        t.put("provider.stream", Authority.DASHBOARD);
        t.put("provider.cancel", Authority.DASHBOARD);
        t.put("tool.execute", Authority.DASHBOARD);
        t.put("approval.list", Authority.DASHBOARD);
        t.put("approval.decide", Authority.USER_ONLY);
        t.put("memory.*", Authority.DASHBOARD);
        t.put("audit.list", Authority.DASHBOARD);
        t.put("cue.set", Authority.DASHBOARD);
        t.put("voice.status", Authority.DASHBOARD);
        t.put("voice.listen.start", Authority.DASHBOARD);
        t.put("voice.listen.stop", Authority.DASHBOARD);
        t.put("voice.speak", Authority.DASHBOARD);
        t.put("voice.stop", Authority.DASHBOARD);
        TABLE = Collections.unmodifiableMap(t);
    }

    private MessageTypes() {
    }

    /** The whole table, in declaration order. */
    public static Map<String, Authority> table() {
        return TABLE;
    }

    /** The authority for a type, or null when the type is unknown. */
    public static Authority authorityOf(String type) {
        Authority exact = TABLE.get(type);
        if (exact != null) {
            return exact;
        }
        for (Map.Entry<String, Authority> e : TABLE.entrySet()) {
            String key = e.getKey();
            if (key.endsWith(".*") && type.startsWith(key.substring(0, key.length() - 1))) {
                return e.getValue();
            }
        }
        return null;
    }

    /** Sorted names of every USER_ONLY type. */
    public static List<String> userOnlyTypes() {
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, Authority> e : TABLE.entrySet()) {
            if (e.getValue() == Authority.USER_ONLY) {
                out.add(e.getKey());
            }
        }
        Collections.sort(out);
        return out;
    }
}