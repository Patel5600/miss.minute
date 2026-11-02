package com.patel5600.missminute.mobile.core;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The pure part of the settings: key names, defaults, strict validation of values that arrive from a
 * page, which changes loosen what she may do, and the quiet-hours window. The Android class
 * {@code app.Settings} only stores what passes through here.
 */
public final class SettingsRules {
    public static final String ROAMING_LEVEL = "roaming_level";
    public static final String DESIRED_RUNNING = "desired_running";
    public static final String KEEP_AFTER_CLOSE = "keep_after_close";
    public static final String HIDE_IN_FULLSCREEN = "hide_in_fullscreen";
    public static final String QUIET_HOURS_ENABLED = "quiet_hours_enabled";
    public static final String QUIET_HOURS_START = "quiet_hours_start";
    public static final String QUIET_HOURS_END = "quiet_hours_end";
    public static final String ROAMING_ENABLED = "roaming_enabled";
    public static final String HIDDEN_UNTIL_MS = "hidden_until_ms";
    public static final String PROACTIVE = "proactive";
    public static final String SHARE_SYSTEM_WITH_REMOTE = "share_system_with_remote";
    public static final String DOCKED_X = "docked_x";
    public static final String DOCKED_Y = "docked_y";

    public static final RoamingLevel DEFAULT_LEVEL = RoamingLevel.CALM;
    /** 23:00, in minutes since midnight. */
    public static final int DEFAULT_QUIET_START = 23 * 60;
    /** 07:00, in minutes since midnight. */
    public static final int DEFAULT_QUIET_END = 7 * 60;
    public static final int MINUTES_PER_DAY = 24 * 60;
    /** "Hide until" may not be set further than this ahead of now (one day). */
    public static final long MAX_HIDE_AHEAD_MS = 24L * 60 * 60 * 1000;

    /** Keys a page may change. {@code desired_running} and the docked position are native-only. */
    private static final Set<String> PAGE_KEYS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            ROAMING_LEVEL, KEEP_AFTER_CLOSE, HIDE_IN_FULLSCREEN, QUIET_HOURS_ENABLED, QUIET_HOURS_START,
            QUIET_HOURS_END, ROAMING_ENABLED, HIDDEN_UNTIL_MS, PROACTIVE, SHARE_SYSTEM_WITH_REMOTE)));

    private static final Set<String> BOOLEAN_KEYS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            KEEP_AFTER_CLOSE, HIDE_IN_FULLSCREEN, QUIET_HOURS_ENABLED, ROAMING_ENABLED, PROACTIVE,
            SHARE_SYSTEM_WITH_REMOTE)));

    /** The two keys that live in the permission file because a kill resets them. */
    private static final List<String> PERMISSION_KEYS = Collections.unmodifiableList(
            Arrays.asList(PROACTIVE, SHARE_SYSTEM_WITH_REMOTE));

    private SettingsRules() {
    }

    public static boolean isPageSettable(String key) {
        return key != null && PAGE_KEYS.contains(key);
    }

    /** True for the keys stored in the permission state instead of the settings file. */
    public static boolean isPermissionKey(String key) {
        return PERMISSION_KEYS.contains(key);
    }

    /** A stored level name, or the default when it is missing or damaged. */
    public static RoamingLevel levelOrDefault(String stored) {
        if (stored != null) {
            for (RoamingLevel level : RoamingLevel.values()) {
                if (level.name().equals(stored)) {
                    return level;
                }
            }
        }
        return DEFAULT_LEVEL;
    }

    /**
     * Checks a value that came from a page and returns it in the type the store keeps: Boolean,
     * String (a level name), Integer (minutes) or Long (milliseconds).
     *
     * @param nowMs the current time, used to bound {@code hidden_until_ms}
     * @throws IllegalArgumentException when the key is not settable or the value has the wrong type or range
     */
    public static Object validate(String key, Object raw, long nowMs) {
        if (!isPageSettable(key)) {
            throw new IllegalArgumentException("setting cannot be changed from the page");
        }
        if (BOOLEAN_KEYS.contains(key)) {
            if (!(raw instanceof Boolean)) {
                throw new IllegalArgumentException("value must be true or false");
            }
            return raw;
        }
        if (ROAMING_LEVEL.equals(key)) {
            if (!(raw instanceof String)) {
                throw new IllegalArgumentException("value must be a level name");
            }
            for (RoamingLevel level : RoamingLevel.values()) {
                if (level.name().equals(raw)) {
                    return level.name();
                }
            }
            throw new IllegalArgumentException("unknown roaming level");
        }
        long number = wholeNumber(raw);
        if (QUIET_HOURS_START.equals(key) || QUIET_HOURS_END.equals(key)) {
            if (number < 0 || number >= MINUTES_PER_DAY) {
                throw new IllegalArgumentException("minutes must be 0 to 1439");
            }
            return (int) number;
        }
        if (HIDDEN_UNTIL_MS.equals(key)) {
            if (number != 0 && (number < nowMs || number > nowMs + MAX_HIDE_AHEAD_MS)) {
                throw new IllegalArgumentException("hide time must be 0 or within the next day");
            }
            return number;
        }
        throw new IllegalArgumentException("unsupported setting");
    }

    private static long wholeNumber(Object raw) {
        if (raw instanceof Integer || raw instanceof Long || raw instanceof Short || raw instanceof Byte) {
            return ((Number) raw).longValue();
        }
        if (raw instanceof Double || raw instanceof Float) {
            double d = ((Number) raw).doubleValue();
            if (!Double.isNaN(d) && !Double.isInfinite(d) && d == Math.rint(d) && Math.abs(d) < 9.0e15) {
                return (long) d;
            }
        }
        throw new IllegalArgumentException("value must be a whole number");
    }

    /** True when the change gives her more freedom and so needs a native confirmation. */
    public static boolean isLoosening(String key, Object oldValue, Object newValue) {
        if (!isPermissionKey(key)) {
            return false;
        }
        return Boolean.TRUE.equals(newValue) && !Boolean.TRUE.equals(oldValue);
    }

    /**
     * Quiet hours: {@code start} (inclusive) to {@code end} (exclusive), in minutes since midnight.
     * A window that ends before it starts runs past midnight; equal times mean no window.
     */
    public static boolean quietHoursActive(boolean enabled, int startMinute, int endMinute, int minuteOfDay) {
        if (!enabled || startMinute == endMinute) {
            return false;
        }
        if (startMinute < endMinute) {
            return minuteOfDay >= startMinute && minuteOfDay < endMinute;
        }
        return minuteOfDay >= startMinute || minuteOfDay < endMinute;
    }
}
