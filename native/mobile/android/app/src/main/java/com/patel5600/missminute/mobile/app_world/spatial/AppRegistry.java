package com.patel5600.missminute.mobile.app_world.spatial;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.RectF;
import android.util.Log;

import com.patel5600.missminute.mobile.core.World;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Catalog of installed launcher applications, their metadata, categorization,
 * and contextual TVA lore commentary. Also generates realistic initial anchor grids.
 */
public final class AppRegistry {
    private static final String TAG = "MMAppRegistry";

    public enum AppCategory {
        COMMUNICATION,
        FINANCE,
        EDUCATION,
        SHOPPING,
        PRODUCTIVITY,
        MEDIA,
        GAME,
        SYSTEM,
        GENERAL
    }

    public static final class AppEntry {
        public final String packageId;
        public final String appName;
        public final String launcherActivity;
        public final AppCategory category;
        public final String contextualQuote;

        public AppEntry(String packageId, String appName, String launcherActivity,
                        AppCategory category, String contextualQuote) {
            this.packageId = packageId;
            this.appName = appName;
            this.launcherActivity = launcherActivity;
            this.category = category;
            this.contextualQuote = contextualQuote;
        }
    }

    private final Context context;
    private final PackageManager packageManager;
    private final Map<String, AppEntry> catalog = new HashMap<>();

    public AppRegistry(Context context) {
        this.context = context.getApplicationContext();
        this.packageManager = context.getPackageManager();
        refresh();
    }

    public synchronized void refresh() {
        catalog.clear();
        Intent launcherIntent = new Intent(Intent.ACTION_MAIN);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);

        List<ResolveInfo> resolved = packageManager.queryIntentActivities(launcherIntent, 0);
        if (resolved != null) {
            for (ResolveInfo info : resolved) {
                if (info.activityInfo == null || info.activityInfo.packageName == null) {
                    continue;
                }
                String pkg = info.activityInfo.packageName;
                String name = info.loadLabel(packageManager).toString();
                String activity = info.activityInfo.name;
                AppCategory category = detectCategory(pkg, name, info.activityInfo.applicationInfo);
                String quote = buildContextualQuote(pkg, name, category);
                catalog.put(pkg, new AppEntry(pkg, name, activity, category, quote));
            }
        }
        Log.i(TAG, "Indexed " + catalog.size() + " launcher apps.");
    }

    public synchronized List<AppEntry> getInstalledApps() {
        return Collections.unmodifiableList(new ArrayList<>(catalog.values()));
    }

    public synchronized AppEntry find(String packageId) {
        return catalog.get(packageId);
    }

    /**
     * Determines the high-level category of an app based on package, name, and system flags.
     */
    public static AppCategory detectCategory(String pkg, String name, ApplicationInfo appInfo) {
        String lowerPkg = pkg.toLowerCase(Locale.US);
        String lowerName = (name != null ? name.toLowerCase(Locale.US) : "");

        if (lowerPkg.contains("imo") || lowerPkg.contains("whatsapp") || lowerPkg.contains("telegram")
                || lowerPkg.contains("messaging") || lowerPkg.contains("viber") || lowerPkg.contains("wechat")
                || lowerName.contains("chat") || lowerName.contains("message")) {
            return AppCategory.COMMUNICATION;
        }
        if (lowerPkg.contains("binance") || lowerPkg.contains("crypto") || lowerPkg.contains("pay")
                || lowerPkg.contains("bank") || lowerPkg.contains("wallet") || lowerPkg.contains("money")
                || lowerName.contains("finance") || lowerName.contains("invest") || lowerName.contains("bank")) {
            return AppCategory.FINANCE;
        }
        if (lowerPkg.contains("uniclare") || lowerPkg.contains("student") || lowerPkg.contains("duolingo")
                || lowerPkg.contains("learn") || lowerPkg.contains("edu") || lowerName.contains("education")
                || lowerName.contains("school") || lowerName.contains("study")) {
            return AppCategory.EDUCATION;
        }
        if (lowerPkg.contains("flipkart") || lowerPkg.contains("amazon") || lowerPkg.contains("shop")
                || lowerPkg.contains("ebay") || lowerPkg.contains("store") || lowerName.contains("shop")
                || lowerName.contains("cart")) {
            return AppCategory.SHOPPING;
        }
        if (lowerPkg.contains("canva") || lowerPkg.contains("paint") || lowerPkg.contains("draw")
                || lowerPkg.contains("photo") || lowerPkg.contains("design") || lowerPkg.contains("office")
                || lowerPkg.contains("docs") || lowerPkg.contains("sheet") || lowerPkg.contains("notes")
                || lowerName.contains("tool") || lowerName.contains("edit")) {
            return AppCategory.PRODUCTIVITY;
        }
        if (lowerPkg.contains("youtube") || lowerPkg.contains("spotify") || lowerPkg.contains("netflix")
                || lowerPkg.contains("video") || lowerPkg.contains("music")) {
            return AppCategory.MEDIA;
        }
        if (appInfo != null && (appInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0) {
            return AppCategory.SYSTEM;
        }
        return AppCategory.GENERAL;
    }

    /**
     * Builds contextual voice dialogue for a specific app or category.
     */
    public static String buildContextualQuote(String pkg, String appName, AppCategory category) {
        String lowerPkg = pkg.toLowerCase(Locale.US);
        String lowerName = (appName != null ? appName.toLowerCase(Locale.US) : "");

        if (lowerPkg.contains("imo") || lowerName.contains("imo")) {
            return "Keepin' tabs on all your cross-temporal chats on imo, sugar!";
        }
        if (lowerPkg.contains("uniclare") || lowerName.contains("uniclare")) {
            return "Studying hard for the Sacred Timeline? Miss Minutes approves of proper education on Uniclare!";
        }
        if (lowerPkg.contains("binance") || lowerName.contains("binance")) {
            return "Watchin' the crypto charts jump like timeline branches on Binance! Don't get liquidated, darlin'!";
        }
        if (lowerPkg.contains("flipkart") || lowerName.contains("flipkart")) {
            return "Browsin' the timeline bazaar on Flipkart! Look out for temporal bargains, sugar!";
        }
        if (lowerPkg.contains("canva") || lowerName.contains("canva")) {
            return "Cookin' up TVA graphics on Canva? Make sure my face has that sweet vintage orange hue!";
        }
        if (lowerPkg.contains("whatsapp") || lowerName.contains("whatsapp")) {
            return "Encrypted timeline dispatches on WhatsApp! The Time Variance Authority sees all anyway, honey!";
        }

        switch (category) {
            case COMMUNICATION:
                return "Sendin' messages across the branches? Be mindful who you're talkin' to, darlin'!";
            case FINANCE:
                return "Countin' temporal credits, sugar? The TVA monitors every single transaction!";
            case EDUCATION:
                return "Knowledge is power in the Sacred Timeline! Keep studyin' hard now!";
            case SHOPPING:
                return "Shoppin' across alternate dimensions? Save some TVA credits for later!";
            case PRODUCTIVITY:
                return "Mighty fine workspace you got here! Time to file some timeline paperwork!";
            case MEDIA:
                return "Enjoyin' some 21st-century entertainment? Miss Minutes has got her eyes on you!";
            case SYSTEM:
                return "Tinker' with your device settings? Don't prune any critical system branches!";
            case GENERAL:
            default:
                return "Ooh, look at this app icon! Mind if I sit right on top of it, sugar?";
        }
    }

    /**
     * Synthesizes default calibrated spatial anchors for installed applications
     * organized in a standard home screen 4-column grid if no calibration has been saved yet.
     */
    public List<SpatialAnchor> generateDefaultGridAnchors(World world, long layoutRevision) {
        List<SpatialAnchor> anchors = new ArrayList<>();
        List<AppEntry> apps = getInstalledApps();
        if (apps.isEmpty()) {
            return anchors;
        }

        // Standard launcher layout parameters (in dp)
        float leftMargin = (float) (world.insetLeft + 16);
        float rightMargin = (float) (world.screenW - world.insetRight - 16);
        float topMargin = (float) (world.insetTop + 48); // below clock / search widget
        float bottomMargin = (float) (world.floorTop() - 16);

        int cols = 4;
        float iconSize = 64f; // typical launcher icon is ~60-70dp
        float availableW = rightMargin - leftMargin;
        float colSpacing = availableW / cols;

        int row = 0;
        int col = 0;
        int page = 0;
        float currentY = topMargin;

        for (AppEntry app : apps) {
            float iconX = leftMargin + (col * colSpacing) + (colSpacing - iconSize) / 2.0f;
            float iconY = currentY;

            RectF bounds = new RectF(iconX, iconY, iconX + iconSize, iconY + iconSize);
            anchors.add(new SpatialAnchor(
                    app.packageId,
                    app.appName,
                    "com.android.launcher",
                    page,
                    0,
                    bounds,
                    (float) world.density,
                    System.currentTimeMillis(),
                    0.9f, // initial default confidence
                    layoutRevision,
                    null
            ));

            col++;
            if (col >= cols) {
                col = 0;
                row++;
                currentY += iconSize + 36f; // icon + title label + padding
                if (currentY + iconSize > bottomMargin) {
                    currentY = topMargin;
                    row = 0;
                    page++;
                    // Cap default generation to first 2 pages
                    if (page >= 2) break;
                }
            }
        }

        Log.i(TAG, "Generated " + anchors.size() + " default grid anchors across " + (page + 1) + " pages.");
        return anchors;
    }
}
