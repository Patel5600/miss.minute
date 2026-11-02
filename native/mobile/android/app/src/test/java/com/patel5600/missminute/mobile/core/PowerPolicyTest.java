package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PowerPolicyTest {
    private static PowerDecision decide(int pct, boolean charging, boolean saver, boolean screenOn) {
        return PowerPolicy.decide(new PowerInputs(pct, charging, saver, screenOn, screenOn, false));
    }

    @Test
    public void normalIs30FpsAndEverythingAllowed() {
        PowerDecision d = decide(80, false, false, true);
        assertEquals(30, d.maxFps);
        assertEquals(PowerTier.ACTIVE, d.tier);
        assertEquals(RoamingLevel.WILD, d.levelCap);
        assertTrue(d.allowJumps);
        assertTrue(d.allowRun);
        assertEquals(1.0, d.speedScale, 0);
    }

    @Test
    public void batterySaverIs15Fps() {
        PowerDecision d = decide(80, false, true, true);
        assertEquals(15, d.maxFps);
        assertEquals(PowerTier.REDUCED, d.tier);
        assertEquals(RoamingLevel.CALM, d.levelCap);
        assertFalse(d.allowJumps);
        assertFalse(d.allowRun);
        assertEquals(0.6, d.speedScale, 1e-9);
    }

    @Test
    public void under20PercentDischargingIs15FpsCappedAtCalmWithNoJumps() {
        PowerDecision d = decide(19, false, false, true);
        assertEquals(15, d.maxFps);
        assertEquals(RoamingLevel.CALM, d.levelCap);
        assertFalse(d.allowJumps);
        assertEquals(PowerTier.REDUCED, d.tier);
        assertEquals(30, decide(20, false, false, true).maxFps);
    }

    @Test
    public void chargingAt15PercentStaysNormal() {
        PowerDecision d = decide(15, true, false, true);
        assertEquals(30, d.maxFps);
        assertEquals(PowerTier.ACTIVE, d.tier);
        assertTrue(d.allowJumps);
    }

    @Test
    public void under10PercentDischargingIsPausedButChargingIsNot() {
        PowerDecision d = decide(9, false, false, true);
        assertEquals(0, d.maxFps);
        assertEquals(PowerTier.PAUSED, d.tier);
        assertEquals(30, decide(9, true, false, true).maxFps);
        assertEquals(15, decide(10, false, false, true).maxFps);
    }

    @Test
    public void screenOffIsPausedWhateverTheBattery() {
        assertEquals(PowerTier.PAUSED, decide(100, true, false, false).tier);
        assertEquals(0, decide(100, true, false, false).maxFps);
    }

    @Test
    public void dozeHintPauses() {
        PowerDecision d = PowerPolicy.decide(new PowerInputs(90, false, false, true, true, true));
        assertEquals(PowerTier.PAUSED, d.tier);
    }
}