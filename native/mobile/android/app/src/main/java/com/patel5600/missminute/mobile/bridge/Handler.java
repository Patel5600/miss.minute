package com.patel5600.missminute.mobile.bridge;

import com.patel5600.missminute.mobile.core.protocol.Message;

import org.json.JSONObject;

/** Answers one kind of request from a page. */
public interface Handler {
    /** How a handler answers. Exactly one call counts; a second one is ignored. May be made later and from any thread. */
    interface Reply {
        void ok(JSONObject payload);

        /** {@code code} must be one of the wire error codes; anything else is sent as {@code internal}. */
        void fail(String code, String message);
    }

    /**
     * Handles a request that already passed the protocol checks and the role check. Answer through
     * {@code reply}, now or later (a confirmation dialog answers when the owner taps). Throw
     * {@link com.patel5600.missminute.mobile.core.protocol.ProtocolException} for an expected failure
     * with a message written in code; any other exception is reported to the page as {@code internal}
     * without its text.
     */
    void handle(Message message, Reply reply) throws Exception;
}
