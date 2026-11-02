package com.patel5600.missminute.mobile.core.protocol;

import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Encoder and decoder for the envelope shared with the web layer. Validation order: size, JSON,
 * version, type, id/name, reply shape, payload, then the type table. Native code reaches
 * this only with text that came from a page.
 */
public final class Protocol {
    public static final int VERSION = 1;
    public static final int MAX_BYTES = 256 * 1024;
    public static final int MAX_ID_LENGTH = 64;
    /**
     * A message type starts with a lowercase letter, then letters, digits and dots (camelCase is
     * needed by names such as {@code permissions.setMode}). Equal to "typePattern" in protocol.json.
     */
    public static final String TYPE_PATTERN = "^[a-z][a-zA-Z0-9.]{0,47}$";
    private static final int MAX_NAME_LENGTH = 64;
    private static final Pattern TYPE = Pattern.compile(TYPE_PATTERN);

    private Protocol() {
    }

    /** Structural checks only (the same first steps as the TypeScript decoder). */
    public static Message decodeEnvelope(String text) throws ProtocolException {
        if (text == null) {
            throw new ProtocolException("bad_json", "message is empty");
        }
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            throw new ProtocolException("too_large", "message is larger than 256 KB");
        }
        JSONObject raw;
        try {
            raw = new JSONObject(text);
        } catch (JSONException e) {
            throw new ProtocolException("bad_json", "message is not a valid JSON object");
        }
        Object v = raw.opt("v");
        if (!(v instanceof Number) || ((Number) v).doubleValue() != VERSION) {
            throw new ProtocolException("bad_version", "unsupported protocol version");
        }
        Object typeObj = raw.opt("type");
        if (!(typeObj instanceof String) || !TYPE.matcher((String) typeObj).matches()) {
            throw new ProtocolException("bad_type", "invalid message type");
        }
        String type = (String) typeObj;

        String id = null;
        String name = null;
        Object idObj = raw.opt("id");
        if ("event".equals(type)) {
            Object nameObj = raw.opt("name");
            if (!(nameObj instanceof String) || ((String) nameObj).isEmpty()
                    || ((String) nameObj).length() > MAX_NAME_LENGTH) {
                throw new ProtocolException("bad_payload", "event name is missing or too long");
            }
            name = (String) nameObj;
            if (idObj != null) {
                if (!(idObj instanceof String) || ((String) idObj).length() > MAX_ID_LENGTH) {
                    throw new ProtocolException("bad_payload", "invalid id");
                }
                id = (String) idObj;
            }
        } else {
            if (!(idObj instanceof String) || ((String) idObj).isEmpty() || ((String) idObj).length() > MAX_ID_LENGTH) {
                throw new ProtocolException("bad_payload", "id is missing, empty or longer than 64 characters");
            }
            id = (String) idObj;
        }

        Boolean ok = null;
        String errorCode = null;
        String errorMessage = null;
        if ("reply".equals(type)) {
            Object okObj = raw.opt("ok");
            if (!(okObj instanceof Boolean)) {
                throw new ProtocolException("bad_payload", "reply needs a boolean ok");
            }
            ok = (Boolean) okObj;
            if (!ok) {
                Object err = raw.opt("error");
                if (!(err instanceof JSONObject) || !(((JSONObject) err).opt("code") instanceof String)) {
                    throw new ProtocolException("bad_payload", "failed reply needs an error object");
                }
                errorCode = ((JSONObject) err).optString("code");
                errorMessage = ((JSONObject) err).optString("message", "");
            }
        }

        Object payload = raw.opt("payload");
        JSONObject payloadObj;
        if (payload == null && "reply".equals(type) && Boolean.FALSE.equals(ok)) {
            payloadObj = new JSONObject();
        } else if (payload instanceof JSONObject) {
            payloadObj = (JSONObject) payload;
        } else {
            throw new ProtocolException("bad_payload", "payload must be an object");
        }
        return new Message(id, type, name, payloadObj, ok, errorCode, errorMessage, null);
    }

    /** Decodes text sent by a page: structure, known type, and not a native-only type. */
    public static Message decode(String text) throws ProtocolException {
        Message m = decodeEnvelope(text);
        Authority authority = MessageTypes.authorityOf(m.type);
        if (authority == null) {
            throw new ProtocolException("unknown_type", "unknown message type");
        }
        if (authority == Authority.NATIVE_ONLY) {
            throw new ProtocolException("forbidden", "message type is reserved for native code");
        }
        return new Message(m.id, m.type, m.name, m.payload, m.ok, m.errorCode, m.errorMessage, authority);
    }

    /** Checks that the page's role may send this message. */
    public static void authorize(Message m, Role role) throws ProtocolException {
        Authority a = m.authority != null ? m.authority : MessageTypes.authorityOf(m.type);
        boolean allowed;
        if (a == null || a == Authority.NATIVE_ONLY) {
            allowed = false;
        } else if (a == Authority.OVERLAY) {
            allowed = role == Role.OVERLAY;
        } else if (a == Authority.DASHBOARD || a == Authority.USER_ONLY) {
            allowed = role == Role.DASHBOARD;
        } else {
            allowed = true;
        }
        if (!allowed) {
            throw new ProtocolException("forbidden", "this page may not send " + m.type);
        }
    }

    public static String reply(String id, JSONObject payload) {
        try {
            return new JSONObject().put("v", VERSION).put("id", id).put("type", "reply").put("ok", true)
                    .put("payload", payload == null ? new JSONObject() : payload).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String error(String id, String code, String message) {
        try {
            JSONObject err = new JSONObject().put("code", code).put("message", message == null ? "" : message);
            return new JSONObject().put("v", VERSION).put("id", id).put("type", "reply").put("ok", false)
                    .put("error", err).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String event(String name, JSONObject payload) {
        try {
            return new JSONObject().put("v", VERSION).put("type", "event").put("name", name)
                    .put("payload", payload == null ? new JSONObject() : payload).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A native-to-page command such as {@code rig.pose}. */
    public static String command(String type, JSONObject payload) {
        try {
            return new JSONObject().put("v", VERSION).put("id", "n-" + Long.toString(System.nanoTime(), 36))
                    .put("type", type).put("payload", payload == null ? new JSONObject() : payload).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}