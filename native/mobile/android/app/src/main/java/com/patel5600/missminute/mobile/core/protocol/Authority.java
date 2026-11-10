package com.patel5600.missminute.mobile.core.protocol;

/** Who may send a message type. A page can never send NATIVE_ONLY. */
public enum Authority {
    /** Either page (the overlay or the dashboard). */
    PAGE,
    /** The overlay page only. */
    OVERLAY,
    /** The dashboard page only. */
    DASHBOARD,
    /** The dashboard page, and only as the result of a direct user action. Model output can never reach these. */
    USER_ONLY,
    /** Native code only (commands to pages, replies, events). */
    NATIVE_ONLY
}