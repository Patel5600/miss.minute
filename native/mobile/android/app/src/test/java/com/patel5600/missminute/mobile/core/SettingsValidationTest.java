package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public class SettingsValidationTest {
    private static final long NOW = 1_700_000_000_000L;

    private static void rejects(String key, Object value) {
        try {
            SettingsRules.validate(key, value, NOW);
            fail("expected " + key + "=" + value + " to be rejected");
        } catch (IllegalArgumentException expected) {
            // good
        }
    }

    @Test
    public void aMissingOrDamagedLevelFallsBackToCalm() {
        assertEquals(RoamingLevel.CALM, SettingsRules.levelOrDefault(null));
        assertEquals(RoamingLevel.CALM, SettingsRules.levelOrDefault(""));
        assertEquals(RoamingLevel.CALM, SettingsRules.levelOrDefault("lively"));
        assertEquals(RoamingLevel.CALM, SettingsRules.levelOrDefault("TURBO"));
        assertEquals(RoamingLevel.WILD, SettingsRules.levelOrDefault("WILD"));
        assertEquals(RoamingLevel.DOCKED, SettingsRules.levelOrDefault("DOCKED"));
    }

    @Test
    public void onlyExactLevelNamesAreAccepted() {
        for (RoamingLevel level : RoamingLevel.values()) {
            assertEquals(level.name(), SettingsRules.validate(SettingsRules.ROAMING_LEVEL, level.name(), NOW));
        }
        rejects(SettingsRules.ROAMING_LEVEL, "calm");
        rejects(SettingsRules.ROAMING_LEVEL, "ULTRA");
        rejects(SettingsRules.ROAMING_LEVEL, 2);
        rejects(SettingsRules.ROAMING_LEVEL, null);
        rejects(SettingsRules.ROAMING_LEVEL, Boolean.TRUE);
    }

    @Test
    public void switchesNeedARealBoolean() {
        String[] keys = {SettingsRules.KEEP_AFTER_CLOSE, SettingsRules.HIDE_IN_FULLSCREEN,
                SettingsRules.QUIET_HOURS_ENABLED, SettingsRules.ROAMING_ENABLED, SettingsRules.PROACTIVE,
                SettingsRules.SHARE_SYSTEM_WITH_REMOTE};
        for (String key : keys) {
            assertEquals(Boolean.TRUE, SettingsRules.validate(key, Boolean.TRUE, NOW));
            assertEquals(Boolean.FALSE, SettingsRules.validate(key, Boolean.FALSE, NOW));
            rejects(key, "true");
            rejects(key, 1);
            rejects(key, 0);
            rejects(key, null);
        }
    }

    @Test
    public void quietHoursMinutesAreWholeNumbersInsideTheDay() {
        assertEquals(0, SettingsRules.validate(SettingsRules.QUIET_HOURS_START, 0, NOW));
        assertEquals(1439, SettingsRules.validate(SettingsRules.QUIET_HOURS_END, 1439L, NOW));
        assertEquals(600, SettingsRules.validate(SettingsRules.QUIET_HOURS_START, 600.0, NOW));
        rejects(SettingsRules.QUIET_HOURS_START, -1);
        rejects(SettingsRules.QUIET_HOURS_START, 1440);
        rejects(SettingsRules.QUIET_HOURS_END, 12.5);
        rejects(SettingsRules.QUIET_HOURS_END, "600");
        rejects(SettingsRules.QUIET_HOURS_END, Double.NaN);
        rejects(SettingsRules.QUIET_HOURS_END, Double.POSITIVE_INFINITY);
        rejects(SettingsRules.QUIET_HOURS_END, null);
    }

    @Test
    public void hideUntilIsZeroOrWithinTheNextDay() {
        assertEquals(0L, SettingsRules.validate(SettingsRules.HIDDEN_UNTIL_MS, 0, NOW));
        assertEquals(NOW + 3_600_000L, SettingsRules.validate(SettingsRules.HIDDEN_UNTIL_MS, NOW + 3_600_000L, NOW));
        assertEquals(NOW + SettingsRules.MAX_HIDE_AHEAD_MS,
                SettingsRules.validate(SettingsRules.HIDDEN_UNTIL_MS, NOW + SettingsRules.MAX_HIDE_AHEAD_MS, NOW));
        rejects(SettingsRules.HIDDEN_UNTIL_MS, NOW - 1);
        rejects(SettingsRules.HIDDEN_UNTIL_MS, NOW + SettingsRules.MAX_HIDE_AHEAD_MS + 1);
        rejects(SettingsRules.HIDDEN_UNTIL_MS, -5);
        rejects(SettingsRules.HIDDEN_UNTIL_MS, "soon");
    }

    @Test
    public void aPageCannotSetTheNativeOnlyKeysOrUnknownOnes() {
        rejects(SettingsRules.DESIRED_RUNNING, Boolean.TRUE);
        rejects(SettingsRules.DOCKED_X, 10);
        rejects(SettingsRules.DOCKED_Y, 10);
        rejects("mode", "AUTHORIZED");
        rejects("", Boolean.TRUE);
        rejects(null, Boolean.TRUE);
        assertFalse(SettingsRules.isPageSettable(SettingsRules.DESIRED_RUNNING));
        assertFalse(SettingsRules.isPageSettable(SettingsRules.DOCKED_X));
        assertTrue(SettingsRules.isPageSettable(SettingsRules.ROAMING_LEVEL));
    }

    @Test
    public void onlySwitchingTheTwoPermissionKeysOnIsLoosening() {
        assertTrue(SettingsRules.isLoosening(SettingsRules.PROACTIVE, false, true));
        assertTrue(SettingsRules.isLoosening(SettingsRules.SHARE_SYSTEM_WITH_REMOTE, Boolean.FALSE, Boolean.TRUE));
        assertFalse("turning it off never asks", SettingsRules.isLoosening(SettingsRules.PROACTIVE, true, false));
        assertFalse("already on", SettingsRules.isLoosening(SettingsRules.PROACTIVE, true, true));
        assertFalse(SettingsRules.isLoosening(SettingsRules.PROACTIVE, false, false));
        assertFalse("other settings never ask", SettingsRules.isLoosening(SettingsRules.KEEP_AFTER_CLOSE, false, true));
        assertFalse(SettingsRules.isLoosening(SettingsRules.ROAMING_LEVEL, "CALM", "WILD"));
        assertFalse(SettingsRules.isLoosening(SettingsRules.PROACTIVE, false, "true"));
    }

    @Test
    public void theTwoPermissionKeysAreTheOnesStoredWithThePermissions() {
        assertTrue(SettingsRules.isPermissionKey(SettingsRules.PROACTIVE));
        assertTrue(SettingsRules.isPermissionKey(SettingsRules.SHARE_SYSTEM_WITH_REMOTE));
        assertFalse(SettingsRules.isPermissionKey(SettingsRules.KEEP_AFTER_CLOSE));
        assertFalse(SettingsRules.isPermissionKey(null));
    }

    @Test
    public void quietHoursStayOffUnlessEnabled() {
        assertFalse(SettingsRules.quietHoursActive(false, 23 * 60, 7 * 60, 2 * 60));
    }

    @Test
    public void aQuietWindowInsideOneDayIncludesItsStartAndExcludesItsEnd() {
        assertFalse(SettingsRules.quietHoursActive(true, 9 * 60, 17 * 60, 9 * 60 - 1));
        assertTrue(SettingsRules.quietHoursActive(true, 9 * 60, 17 * 60, 9 * 60));
        assertTrue(SettingsRules.quietHoursActive(true, 9 * 60, 17 * 60, 12 * 60));
        assertTrue(SettingsRules.quietHoursActive(true, 9 * 60, 17 * 60, 17 * 60 - 1));
        assertFalse(SettingsRules.quietHoursActive(true, 9 * 60, 17 * 60, 17 * 60));
    }

    @Test
    public void aQuietWindowThatEndsBeforeItStartsRunsPastMidnight() {
        int start = 23 * 60;
        int end = 7 * 60;
        assertTrue(SettingsRules.quietHoursActive(true, start, end, 23 * 60));
        assertTrue(SettingsRules.quietHoursActive(true, start, end, 23 * 60 + 59));
        assertTrue(SettingsRules.quietHoursActive(true, start, end, 0));
        assertTrue(SettingsRules.quietHoursActive(true, start, end, 6 * 60 + 59));
        assertFalse(SettingsRules.quietHoursActive(true, start, end, 7 * 60));
        assertFalse(SettingsRules.quietHoursActive(true, start, end, 12 * 60));
        assertFalse(SettingsRules.quietHoursActive(true, start, end, 22 * 60 + 59));
    }

    @Test
    public void equalStartAndEndMeanNoQuietWindow() {
        for (int minute = 0; minute < SettingsRules.MINUTES_PER_DAY; minute += 37) {
            assertFalse(SettingsRules.quietHoursActive(true, 600, 600, minute));
        }
    }

    @Test
    public void theDefaultQuietWindowIsElevenAtNightToSevenInTheMorning() {
        assertEquals(23 * 60, SettingsRules.DEFAULT_QUIET_START);
        assertEquals(7 * 60, SettingsRules.DEFAULT_QUIET_END);
        assertEquals(RoamingLevel.CALM, SettingsRules.DEFAULT_LEVEL);
    }
}
