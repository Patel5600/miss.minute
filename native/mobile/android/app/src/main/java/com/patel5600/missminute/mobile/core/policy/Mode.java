package com.patel5600.missminute.mobile.core.policy;

/** How much she may do on her own. */
public enum Mode {
    /** She watches and answers; nothing runs without the owner tapping it. */
    OBSERVE,
    /** Low-risk helpers run; anything else asks first. */
    SUGGEST,
    /** Low-risk and granted capabilities may run automatically within a budget. */
    AUTHORIZED
}