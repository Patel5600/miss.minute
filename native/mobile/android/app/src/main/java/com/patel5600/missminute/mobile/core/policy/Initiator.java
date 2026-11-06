package com.patel5600.missminute.mobile.core.policy;

/** Who is behind an action. */
public enum Initiator {
    /** A direct tap in the UI. */
    OWNER,
    /** A tool call during a turn the owner started. */
    MODEL,
    /** Event-driven, with no owner message. */
    PROACTIVE
}