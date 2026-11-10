package com.patel5600.missminute.mobile.core;

/**
 * Battery-aware behaviour. Table: normal 30 fps; battery saver 15; under 20% and discharging 15
 * with the level capped at CALM and no jumps; under 10% and discharging paused; screen off paused.
 * Charging at 15% stays normal unless battery saver is on.
 */
public final class PowerPolicy {
    private PowerPolicy() {
    }

    public static PowerDecision decide(PowerInputs in) {
        boolean discharging = !in.charging;
        if (!in.screenOn || in.dozeHint) {
            return new PowerDecision(0, RoamingLevel.DOCKED, false, false, 0, PowerTier.PAUSED);
        }
        if (discharging && in.batteryPercent < 10) {
            return new PowerDecision(0, RoamingLevel.DOCKED, false, false, 0, PowerTier.PAUSED);
        }
        if (in.powerSave || (discharging && in.batteryPercent < 20)) {
            return new PowerDecision(15, RoamingLevel.CALM, false, false, 0.6, PowerTier.REDUCED);
        }
        return new PowerDecision(30, RoamingLevel.WILD, true, true, 1.0, PowerTier.ACTIVE);
    }
}