package com.patel5600.missminute.mobile.debug;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.core.kill.KillState;
import com.patel5600.missminute.mobile.core.policy.PermissionState;
import com.patel5600.missminute.mobile.overlay.OverlayService;

/**
 * Debug builds only. {@code adb shell am broadcast -a com.patel5600.missminute.debug.DUMP_STATE -p
 * com.patel5600.missminute.mobile} writes one MMState line to logcat for the device checks. It only
 * reads: it cannot trigger or clear the kill switch, change permissions or touch consent.
 */
public final class DebugCommandReceiver extends BroadcastReceiver {
    public static final String ACTION_DUMP_STATE = "com.patel5600.missminute.debug.DUMP_STATE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DUMP_STATE.equals(intent.getAction())) {
            return;
        }
        MissMinutesApp app = MissMinutesApp.from(context);
        KillState kill = app.killSwitch().state();
        PermissionState permissions = app.permissionStore().load();
        Log.d("MMState", OverlayService.debugState()
                + " desiredRunning=" + app.settings().desiredRunning()
                + " level=" + app.settings().roamingLevel()
                + " mode=" + permissions.mode
                + " proactive=" + permissions.proactive
                + " killed=" + kill.killed
                + " noticePending=" + kill.noticePending);
    }
}
