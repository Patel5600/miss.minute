package com.patel5600.missminute.mobile.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.patel5600.missminute.mobile.core.RoamingLevel;
import com.patel5600.missminute.mobile.core.SettingsRules;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Her settings, kept in the SharedPreferences file {@code miss_minutes_settings}. Reads never throw:
 * a damaged value falls back to its default. Values from a page are checked by {@link SettingsRules}
 * before they reach {@link #apply}. {@code proactive} and {@code share_system_with_remote} are not
 * stored here: they live in the permission file so one kill resets them together with the mode.
 */
public final class Settings {
    public static final String PREFS_NAME = "miss_minutes_settings";

    private final SharedPreferences prefs;

    public Settings(Context context) {
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** For registering a change listener. Keep a strong reference to the listener. */
    public SharedPreferences preferences() {
        return prefs;
    }

    private boolean bool(String key, boolean fallback) {
        try {
            return prefs.getBoolean(key, fallback);
        } catch (ClassCastException e) {
            return fallback;
        }
    }

    private int integer(String key, int fallback) {
        try {
            return prefs.getInt(key, fallback);
        } catch (ClassCastException e) {
            return fallback;
        }
    }

    private long longValue(String key, long fallback) {
        try {
            return prefs.getLong(key, fallback);
        } catch (ClassCastException e) {
            return fallback;
        }
    }

    public RoamingLevel roamingLevel() {
        try {
            return SettingsRules.levelOrDefault(prefs.getString(SettingsRules.ROAMING_LEVEL, null));
        } catch (ClassCastException e) {
            return SettingsRules.DEFAULT_LEVEL;
        }
    }

    /** True while the owner wants her on the screen; a sticky restart only revives her when this is set. */
    public boolean desiredRunning() {
        return bool(SettingsRules.DESIRED_RUNNING, false);
    }

    /**
     * Written with apply(): the in-memory value changes at once and the disk write happens off the main
     * thread (a commit() here blocked the main thread on an fsync during cold start). A sticky restart is
     * also guarded by the kill-state file, which is written synchronously by the kill switch itself.
     */
    public void setDesiredRunning(boolean value) {
        prefs.edit().putBoolean(SettingsRules.DESIRED_RUNNING, value).apply();
    }

    public boolean keepAfterClose() {
        return bool(SettingsRules.KEEP_AFTER_CLOSE, false);
    }

    public boolean hideInFullscreen() {
        return bool(SettingsRules.HIDE_IN_FULLSCREEN, true);
    }

    public boolean quietHoursEnabled() {
        return bool(SettingsRules.QUIET_HOURS_ENABLED, false);
    }

    public int quietHoursStart() {
        return minute(SettingsRules.QUIET_HOURS_START, SettingsRules.DEFAULT_QUIET_START);
    }

    public int quietHoursEnd() {
        return minute(SettingsRules.QUIET_HOURS_END, SettingsRules.DEFAULT_QUIET_END);
    }

    private int minute(String key, int fallback) {
        int value = integer(key, fallback);
        return value >= 0 && value < SettingsRules.MINUTES_PER_DAY ? value : fallback;
    }

    public boolean roamingEnabled() {
        return bool(SettingsRules.ROAMING_ENABLED, true);
    }

    public long hiddenUntilMs() {
        return Math.max(0, longValue(SettingsRules.HIDDEN_UNTIL_MS, 0));
    }

    public void setHiddenUntilMs(long untilMs) {
        prefs.edit().putLong(SettingsRules.HIDDEN_UNTIL_MS, Math.max(0, untilMs)).apply();
    }

    public void setRoamingLevel(RoamingLevel level) {
        prefs.edit().putString(SettingsRules.ROAMING_LEVEL, level.name()).apply();
    }

    /** Where she last came to rest after the owner moved her, in dp, or null when never moved. */
    public float[] dockedPosition() {
        try {
            if (!prefs.contains(SettingsRules.DOCKED_X) || !prefs.contains(SettingsRules.DOCKED_Y)) {
                return null;
            }
            float x = prefs.getFloat(SettingsRules.DOCKED_X, Float.NaN);
            float y = prefs.getFloat(SettingsRules.DOCKED_Y, Float.NaN);
            if (Float.isNaN(x) || Float.isNaN(y) || Float.isInfinite(x) || Float.isInfinite(y)) {
                return null;
            }
            return new float[] {x, y};
        } catch (ClassCastException e) {
            return null;
        }
    }

    public void setDockedPosition(float x, float y) {
        if (Float.isNaN(x) || Float.isNaN(y) || Float.isInfinite(x) || Float.isInfinite(y)) {
            return;
        }
        prefs.edit().putFloat(SettingsRules.DOCKED_X, x).putFloat(SettingsRules.DOCKED_Y, y).apply();
    }

    /**
     * Stores a value that {@link SettingsRules#validate} accepted. Only the keys kept in this file are
     * handled; the two permission keys are written by the settings handler to the permission store.
     */
    public void apply(String key, Object value) {
        SharedPreferences.Editor editor = prefs.edit();
        if (value instanceof Boolean) {
            editor.putBoolean(key, (Boolean) value);
        } else if (value instanceof String) {
            editor.putString(key, (String) value);
        } else if (value instanceof Integer) {
            editor.putInt(key, (Integer) value);
        } else if (value instanceof Long) {
            editor.putLong(key, (Long) value);
        } else {
            throw new IllegalArgumentException("unsupported value type");
        }
        editor.apply();
    }

    /** What a page may read from this file. */
    public JSONObject toJson() throws JSONException {
        return new JSONObject()
                .put(SettingsRules.ROAMING_LEVEL, roamingLevel().name())
                .put(SettingsRules.KEEP_AFTER_CLOSE, keepAfterClose())
                .put(SettingsRules.HIDE_IN_FULLSCREEN, hideInFullscreen())
                .put(SettingsRules.QUIET_HOURS_ENABLED, quietHoursEnabled())
                .put(SettingsRules.QUIET_HOURS_START, quietHoursStart())
                .put(SettingsRules.QUIET_HOURS_END, quietHoursEnd())
                .put(SettingsRules.ROAMING_ENABLED, roamingEnabled())
                .put(SettingsRules.HIDDEN_UNTIL_MS, hiddenUntilMs());
    }
}
