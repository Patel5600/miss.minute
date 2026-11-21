package com.patel5600.missminute.mobile.core;

/** What the power manager observed. Immutable. */
public final class PowerInputs {
    /** 0 to 100. */
    public final int batteryPercent;
    public final boolean charging;
    public final boolean powerSave;
    public final boolean screenOn;
    public final boolean interactive;
    /** True when the device reports idle (Doze) mode. */
    public final boolean dozeHint;

    public PowerInputs(int batteryPercent, boolean charging, boolean powerSave,
                       boolean screenOn, boolean interactive, boolean dozeHint) {
        this.batteryPercent = batteryPercent;
        this.charging = charging;
        this.powerSave = powerSave;
        this.screenOn = screenOn;
        this.interactive = interactive;
        this.dozeHint = dozeHint;
    }
}