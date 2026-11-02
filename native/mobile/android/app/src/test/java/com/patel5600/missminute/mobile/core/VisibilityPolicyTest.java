package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class VisibilityPolicyTest {
    private static final long NOW = 1_000_000L;

    private static VisibilityInputs in(boolean screenOn, boolean keyguard, boolean fullscreen, boolean roamingOff,
                                       long hiddenUntil, boolean quiet, boolean focus, PowerTier tier) {
        return new VisibilityInputs(screenOn, keyguard, fullscreen, roamingOff, hiddenUntil, NOW, quiet, focus, tier);
    }

    private static VisibilityInputs normal() {
        return in(true, false, false, false, 0, false, false, PowerTier.ACTIVE);
    }

    @Test
    public void normalIsActive() {
        assertEquals(Visibility.ACTIVE, VisibilityPolicy.decide(normal()));
    }

    @Test
    public void roamingOffGivesDocked() {
        assertEquals(Visibility.DOCKED,
                VisibilityPolicy.decide(in(true, false, false, true, 0, false, false, PowerTier.ACTIVE)));
    }

    @Test
    public void fullscreenBeatsEverythingEvenRoamingOffAndScreenOff() {
        assertEquals(Visibility.HIDDEN,
                VisibilityPolicy.decide(in(true, false, true, true, 0, false, false, PowerTier.ACTIVE)));
        assertEquals(Visibility.HIDDEN,
                VisibilityPolicy.decide(in(false, true, true, false, 0, false, false, PowerTier.ACTIVE)));
    }

    @Test
    public void quietHoursBeatEverything() {
        assertEquals(Visibility.HIDDEN,
                VisibilityPolicy.decide(in(false, false, false, true, 0, true, false, PowerTier.PAUSED)));
        assertEquals(Visibility.HIDDEN,
                VisibilityPolicy.decide(in(true, false, false, false, 0, true, false, PowerTier.ACTIVE)));
    }

    @Test
    public void screenOffOrLockScreenIsPaused() {
        assertEquals(Visibility.PAUSED,
                VisibilityPolicy.decide(in(false, false, false, false, 0, false, false, PowerTier.ACTIVE)));
        assertEquals(Visibility.PAUSED,
                VisibilityPolicy.decide(in(true, true, false, false, 0, false, false, PowerTier.ACTIVE)));
    }

    @Test
    public void focusModeAndHideUntilAndCriticalBatteryHideHer() {
        assertEquals(Visibility.HIDDEN,
                VisibilityPolicy.decide(in(true, false, false, false, 0, false, true, PowerTier.ACTIVE)));
        assertEquals(Visibility.HIDDEN,
                VisibilityPolicy.decide(in(true, false, false, false, NOW + 1, false, false, PowerTier.ACTIVE)));
        assertEquals(Visibility.ACTIVE,
                VisibilityPolicy.decide(in(true, false, false, false, NOW, false, false, PowerTier.ACTIVE)));
        assertEquals(Visibility.HIDDEN,
                VisibilityPolicy.decide(in(true, false, false, false, 0, false, false, PowerTier.PAUSED)));
    }

    @Test
    public void hiddenBeatsDockedWhenBothApply() {
        assertEquals(Visibility.HIDDEN,
                VisibilityPolicy.decide(in(true, false, false, true, 0, false, true, PowerTier.ACTIVE)));
    }
}