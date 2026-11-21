package com.patel5600.missminute.mobile.core.protocol;

import org.json.JSONObject;

/** One decoded envelope. Replies carry {@link #ok}; events carry {@link #name}; others carry an id. */
public final class Message {
    /** Null only for events without an id. */
    public final String id;
    public final String type;
    /** Event name, else null. */
    public final String name;
    public final JSONObject payload;
    /** Reply outcome, else null. */
    public final Boolean ok;
    public final String errorCode;
    public final String errorMessage;
    /** Null until {@link Protocol#decode} classifies the type. */
    public final Authority authority;

    public Message(String id, String type, String name, JSONObject payload, Boolean ok,
                   String errorCode, String errorMessage, Authority authority) {
        this.id = id;
        this.type = type;
        this.name = name;
        this.payload = payload;
        this.ok = ok;
        this.errorCode = errorCode;
        this.errorMessage = errorMessage;
        this.authority = authority;
    }

    /** True when the router must require a native confirmation before acting. */
    public boolean isUserOnly() {
        return authority == Authority.USER_ONLY;
    }
}