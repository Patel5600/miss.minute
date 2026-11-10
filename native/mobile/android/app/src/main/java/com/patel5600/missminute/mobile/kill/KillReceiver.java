package com.patel5600.missminute.mobile.kill;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.patel5600.missminute.mobile.core.kill.KillPath;

/**
 * Target of the "Stop Miss Minutes" notification action. Not exported: only the PendingIntent the app
 * itself posted can reach it. It works with no service alive, because the process starts for it and
 * the kill switch's always-present killables do not need a running service.
 */
public final class KillReceiver extends BroadcastReceiver {
    public static final String ACTION_KILL = "com.patel5600.missminute.action.KILL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_KILL.equals(intent.getAction())) {
            return;
        }
        KillSwitch.trigger(context, KillPath.NOTIFICATION);
    }
}
