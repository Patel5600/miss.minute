package com.patel5600.missminute.mobile.app_world.lifecycle;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Process;
import android.provider.Settings;
import android.util.Log;

import com.patel5600.missminute.mobile.app_world.behaviour.EventRouter;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Foreground application monitor using UsageStatsManager.
 * Detects real foreground application transitions (e.g. launching WhatsApp, Binance, etc.)
 * and notifies the EventRouter so Miss Minutes can safely retreat to a screen-edge perch.
 */
public final class ForegroundMonitor {
    private static final String TAG = "MMForegroundMonitor";

    private final Context context;
    private final UsageStatsManager usageStatsManager;
    private final EventRouter eventRouter;
    private final Set<String> launcherPackages = new HashSet<>();

    private String lastForegroundPackage;
    private long lastQueryTimeMs;

    public ForegroundMonitor(Context context, EventRouter eventRouter) {
        this.context = context.getApplicationContext();
        this.usageStatsManager = (UsageStatsManager) this.context.getSystemService(Context.USAGE_STATS_SERVICE);
        this.eventRouter = eventRouter;
        this.lastQueryTimeMs = System.currentTimeMillis() - 10_000L;
        findLauncherPackages();
    }

    private void findLauncherPackages() {
        launcherPackages.clear();
        PackageManager pm = context.getPackageManager();
        Intent intent = new Intent(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_HOME);

        List<ResolveInfo> resolves = pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
        if (resolves != null) {
            for (ResolveInfo ri : resolves) {
                if (ri.activityInfo != null && ri.activityInfo.packageName != null) {
                    launcherPackages.add(ri.activityInfo.packageName);
                }
            }
        }
        // Common OEM launcher packages
        launcherPackages.add("com.google.android.apps.nexuslauncher");
        launcherPackages.add("com.android.launcher3");
        launcherPackages.add("com.android.launcher");
        launcherPackages.add("com.miui.home");
        launcherPackages.add("com.sec.android.app.launcher");
        launcherPackages.add("com.huawei.android.launcher");
        launcherPackages.add("com.oppo.launcher");
        launcherPackages.add("com.oneplus.launcher");
    }

    /**
     * Checks if the app has been granted PACKAGE_USAGE_STATS permission by the user.
     */
    public boolean hasUsageAccess() {
        AppOpsManager appOps = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) return false;
        int mode = appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.getPackageName()
        );
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    /**
     * Creates an Intent to prompt the user to grant Usage Access in System Settings.
     */
    public Intent createUsageAccessSettingsIntent() {
        Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    public boolean isLauncher(String packageName) {
        if (packageName == null) return true;
        return launcherPackages.contains(packageName) ||
                packageName.contains("launcher") ||
                packageName.contains("home");
    }

    public boolean isLauncherInForeground() {
        return isLauncher(lastForegroundPackage);
    }

    public String getCurrentForegroundPackage() {
        return lastForegroundPackage;
    }

    /**
     * Queries recent usage events to check if a new application has moved to the foreground.
     * Evaluated when screen wakes or on foreground service check.
     */
    public synchronized void pollForegroundChange() {
        if (!hasUsageAccess() || usageStatsManager == null) {
            return;
        }

        long now = System.currentTimeMillis();
        UsageEvents events = usageStatsManager.queryEvents(lastQueryTimeMs, now);
        lastQueryTimeMs = now;

        if (events == null) {
            return;
        }

        UsageEvents.Event event = new UsageEvents.Event();
        String currentFg = null;

        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            if (event.getEventType() == UsageEvents.Event.ACTIVITY_RESUMED) {
                currentFg = event.getPackageName();
            }
        }

        if (currentFg != null && !currentFg.equals(lastForegroundPackage) && !currentFg.equals(context.getPackageName())) {
            Log.i(TAG, "Foreground changed: " + lastForegroundPackage + " -> " + currentFg);
            lastForegroundPackage = currentFg;
            if (eventRouter != null) {
                eventRouter.dispatch(EventRouter.DeviceEvent.foregroundChanged(currentFg, now));
            }
        }
    }
}
