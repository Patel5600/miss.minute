package com.patel5600.missminute.mobile.core;

/** Source of wall-clock milliseconds. Injected so logic that depends on time is testable. */
public interface Clock {
    long nowMs();
}