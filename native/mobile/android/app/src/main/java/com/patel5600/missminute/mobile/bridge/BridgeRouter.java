package com.patel5600.missminute.mobile.bridge;

import com.patel5600.missminute.mobile.core.Vocabulary;
import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.core.protocol.MessageTypes;
import com.patel5600.missminute.mobile.core.protocol.Protocol;
import com.patel5600.missminute.mobile.core.protocol.ProtocolException;
import com.patel5600.missminute.mobile.core.protocol.Role;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Takes the text a page posted, checks it (size, JSON, version, type, who may send it) and hands it to
 * the handler registered for its type. The role is fixed by the WebView the text came from, never by
 * the message. Replies go to a {@link Sink}. Pure Java: the transport (WebHost) supplies the sink and
 * the thread.
 */
public final class BridgeRouter {
    /** Native supplied liveness check for owner-gated dashboard messages. */
    public interface OwnerSessionCheck {
        boolean isActive();
    }

    /** Where finished replies go: the transport that carried the request. */
    public interface Sink {
        void send(String json);
    }

    /** Told when a handler throws something unexpected, so a debug build can log the class name. */
    public interface FailureListener {
        void onHandlerFailure(String type, Throwable error);
    }

    private static final String INTERNAL_MESSAGE = "Something went wrong inside the app.";
    private static final int ID_SCAN_CHARS = 300;
    private static final Pattern ID_IN_PREFIX = Pattern.compile("\"id\"\\s*:\\s*\"([^\"\\\\]{1,64})\"");

    private final Role role;
    private final OwnerSessionCheck ownerSessionCheck;
    private final Supplier<String> ownerSessionId;
    private final boolean enforceOwnerSession;
    private final Map<String, Handler> handlers = new ConcurrentHashMap<>();
    private volatile FailureListener failureListener;

    public BridgeRouter(Role role) {
        this(role, null, null);
    }

    public BridgeRouter(Role role, OwnerSessionCheck ownerSessionCheck) {
        this(role, ownerSessionCheck, null);
    }

    public BridgeRouter(Role role, OwnerSessionCheck ownerSessionCheck, Supplier<String> ownerSessionId) {
        this.role = role;
        this.enforceOwnerSession = ownerSessionCheck != null;
        this.ownerSessionCheck = ownerSessionCheck == null ? () -> false : ownerSessionCheck;
        this.ownerSessionId = ownerSessionId;
    }

    public Role role() {
        return role;
    }

    public void setFailureListener(FailureListener listener) {
        this.failureListener = listener;
    }

    /**
     * Registers a handler for a message type, or for a whole family with a key such as
     * {@code reminders.*}. The key must exist in the protocol table.
     */
    public BridgeRouter register(String typeOrFamily, Handler handler) {
        if (MessageTypes.authorityOf(typeOrFamily) == null) {
            throw new IllegalArgumentException("not a message type in the protocol table: " + typeOrFamily);
        }
        handlers.put(typeOrFamily, handler);
        return this;
    }

    private Handler find(String type) {
        Handler exact = handlers.get(type);
        if (exact != null) {
            return exact;
        }
        for (Map.Entry<String, Handler> entry : handlers.entrySet()) {
            String key = entry.getKey();
            if (key.endsWith(".*") && type.startsWith(key.substring(0, key.length() - 1))) {
                return entry.getValue();
            }
        }
        return null;
    }

    /**
     * Handles one posted text on the calling thread. Never throws for page input: every failure is
     * answered with an error reply (when the request id can be found) or dropped.
     */
    public void dispatch(String text, final Sink sink) {
        final Message message;
        try {
            message = Protocol.decode(text);
            Protocol.authorize(message, role);
        } catch (ProtocolException e) {
            String id = bestEffortId(text);
            if (id != null) {
                sink.send(Protocol.error(id, e.code, e.getMessage()));
            }
            return;
        }

        final boolean ownerGated = enforceOwnerSession && role == Role.DASHBOARD
                && OwnerMessagePolicy.requiresOwnerSession(message.type);
        final String initiatingOwnerSession;
        if (ownerGated) {
            boolean active;
            try { active = ownerSessionCheck.isActive(); }
            catch (RuntimeException | LinkageError error) { active = false; }
            if (!active) {
                sink.send(Protocol.error(message.id, "owner_auth_required",
                        "Unlock Miss Minutes before using this owner capability."));
                return;
            }
            String captured = null;
            if (ownerSessionId != null) {
                try { captured = ownerSessionId.get(); }
                catch (RuntimeException | LinkageError ignored) { }
            }
            initiatingOwnerSession = captured;
        } else {
            initiatingOwnerSession = null;
        }

        Handler handler = find(message.type);
        if (handler == null) {
            sink.send(Protocol.error(message.id, "unavailable", "This is not available in this version."));
            return;
        }
        final Once reply = new Once(message.id, sink, () -> {
            if (!ownerGated) return true;
            try {
                if (!ownerSessionCheck.isActive()) return false;
                return ownerSessionId == null || java.util.Objects.equals(
                        initiatingOwnerSession, ownerSessionId.get());
            } catch (RuntimeException | LinkageError error) {
                return false;
            }
        });
        try {
            handler.handle(message, reply);
        } catch (ProtocolException e) {
            reply.fail(e.code, e.getMessage());
        } catch (Exception e) {
            FailureListener listener = failureListener;
            if (listener != null) {
                listener.onHandlerFailure(message.type, e);
            }
            reply.fail("internal", INTERNAL_MESSAGE);
        }
    }

    /**
     * The request id, when it can be found without trusting the rest of the text, so a rejected request
     * still gets an answer. Null when there is none (the page then times out).
     */
    static String bestEffortId(String text) {
        if (text == null) {
            return null;
        }
        if (text.length() <= Protocol.MAX_BYTES) {
            try {
                Object id = new JSONObject(text).opt("id");
                if (id instanceof String && !((String) id).isEmpty() && ((String) id).length() <= Protocol.MAX_ID_LENGTH) {
                    return (String) id;
                }
            } catch (JSONException ignored) {
                // fall through to the prefix scan
            }
        }
        Matcher matcher = ID_IN_PREFIX.matcher(text.substring(0, Math.min(text.length(), ID_SCAN_CHARS)));
        return matcher.find() ? matcher.group(1) : null;
    }

    /** Sends at most one reply, whatever the handler does. */
    private static final class Once implements Handler.Reply {
        private final String id;
        private final Sink sink;
        private final BooleanSupplier authorizationStillValid;
        private final AtomicBoolean done = new AtomicBoolean(false);

        Once(String id, Sink sink, BooleanSupplier authorizationStillValid) {
            this.id = id;
            this.sink = sink;
            this.authorizationStillValid = authorizationStillValid;
        }

        @Override
        public void ok(JSONObject payload) {
            if (done.compareAndSet(false, true)) {
                sink.send(authorizationStillValid.getAsBoolean()
                        ? Protocol.reply(id, payload)
                        : Protocol.error(id, "owner_auth_required", "Owner access changed before this request completed."));
            }
        }

        @Override
        public void fail(String code, String message) {
            if (done.compareAndSet(false, true)) {
                String safeCode = Vocabulary.ERROR_CODES.contains(code) ? code : "internal";
                sink.send(authorizationStillValid.getAsBoolean()
                        ? Protocol.error(id, safeCode, message)
                        : Protocol.error(id, "owner_auth_required", "Owner access changed before this request completed."));
            }
        }
    }
}
