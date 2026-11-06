package com.patel5600.missminute.mobile.core.protocol;

/** A protocol violation. {@link #code} is one of the wire error codes. */
public final class ProtocolException extends Exception {
    private static final long serialVersionUID = 1L;

    public final String code;

    public ProtocolException(String code, String message) {
        super(message);
        this.code = code;
    }
}