package com.patel5600.missminute.mobile.overlay;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.PowerManager;

import com.patel5600.missminute.mobile.core.PowerInputs;

import java.util.function.Supplier;

/**
 * A minimal reader of the battery, charger, battery saver, screen and Doze state, used until the
 * event-driven power monitor of the system-knowledge stage replaces it. It reads at the moment it is
 * asked and keeps nothing.
 */
final class LocalPowerReader implements Supplier<PowerInputs> {
    private final Context context;
    private final PowerManager powerManager;

    LocalPowerReader(Context context) {
        this.context = context;
        this.powerManager = context.getSystemService(PowerManager.class);
    }

    @Override
    public PowerInputs get() {
        // A sticky broadcast: passing no receiver just returns the last battery state.
        Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int percent = 100;
        boolean charging = false;
        if (battery != null) {
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            if (level >= 0 && scale > 0) {
                percent = Math.round(level * 100f / scale);
            }
            int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            int plugged = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
            charging = plugged != 0 || status == BatteryManager.BATTERY_STATUS_CHARGING
                    || status == BatteryManager.BATTERY_STATUS_FULL;
        }
        boolean interactive = powerManager == null || powerManager.isInteractive();
        boolean powerSave = powerManager != null && powerManager.isPowerSaveMode();
        boolean doze = powerManager != null && powerManager.isDeviceIdleMode();
        return new PowerInputs(Math.max(0, Math.min(100, percent)), charging, powerSave, interactive, interactive, doze);
    }
}
