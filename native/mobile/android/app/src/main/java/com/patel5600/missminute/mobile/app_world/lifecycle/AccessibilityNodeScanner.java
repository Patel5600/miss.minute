package com.patel5600.missminute.mobile.app_world.lifecycle;

import android.graphics.Rect;
import android.graphics.RectF;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;

import com.patel5600.missminute.mobile.app_world.spatial.SpatialAnchor;

import java.util.ArrayList;
import java.util.List;

/**
 * Strategy C: Optional accessibility integration helper that inspects active launcher
 * window hierarchy node bounds to auto-detect icon positions.
 */
public final class AccessibilityNodeScanner {
    private static final String TAG = "MMAccessibilityScanner";

    private AccessibilityNodeScanner() {
    }

    /**
     * Recursively traverses an AccessibilityNodeInfo hierarchy to discover app icons and labels.
     */
    public static List<SpatialAnchor> scanLauncherNodes(
            AccessibilityNodeInfo root,
            float density,
            long layoutRevision,
            String launcherPackage) {

        List<SpatialAnchor> discovered = new ArrayList<>();
        if (root == null || density <= 0) {
            return discovered;
        }

        scanRecursive(root, density, layoutRevision, launcherPackage, discovered);
        Log.i(TAG, "Accessibility scan found " + discovered.size() + " icon anchors.");
        return discovered;
    }

    private static void scanRecursive(
            AccessibilityNodeInfo node,
            float density,
            long layoutRevision,
            String launcherPackage,
            List<SpatialAnchor> out) {

        if (node == null) return;

        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        CharSequence pkg = node.getPackageName();

        // Check if node looks like an interactive launcher icon
        if (node.isClickable() && (text != null || desc != null)) {
            Rect boundsPx = new Rect();
            node.getBoundsInScreen(boundsPx);

            float widthDp = (boundsPx.right - boundsPx.left) / density;
            float heightDp = (boundsPx.bottom - boundsPx.top) / density;

            // Launcher icons typically are between 40dp and 120dp wide/tall
            if (widthDp >= 36f && widthDp <= 140f && heightDp >= 36f && heightDp <= 140f) {
                String name = text != null ? text.toString() : desc.toString();
                String targetPkg = pkg != null ? pkg.toString() : "unknown.app";

                RectF boundsDp = new RectF(
                        boundsPx.left / density,
                        boundsPx.top / density,
                        boundsPx.right / density,
                        boundsPx.bottom / density
                );

                SpatialAnchor anchor = new SpatialAnchor(
                        targetPkg,
                        name,
                        launcherPackage != null ? launcherPackage : "com.android.launcher",
                        0,
                        0,
                        boundsDp,
                        density,
                        System.currentTimeMillis(),
                        0.95f,
                        layoutRevision,
                        null
                );
                out.add(anchor);
            }
        }

        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                scanRecursive(child, density, layoutRevision, launcherPackage, out);
                child.recycle();
            }
        }
    }
}
