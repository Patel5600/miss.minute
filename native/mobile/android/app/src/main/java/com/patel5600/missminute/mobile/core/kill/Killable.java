package com.patel5600.missminute.mobile.core.kill;

/** Something the kill switch must stop: the service, the overlay, listening, speech, a request. */
public interface Killable {
    /** A fixed label (never user or model text). It is recorded in the audit log. */
    String label();

    void onKill() throws Exception;
}