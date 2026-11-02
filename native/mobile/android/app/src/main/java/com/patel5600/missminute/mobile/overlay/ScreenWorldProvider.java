package com.patel5600.missminute.mobile.overlay;

import android.content.Context;
import android.graphics.Insets;
import android.graphics.Rect;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.WindowMetrics;

import com.patel5600.missminute.mobile.core.World;

/**
 * Measures the screen for the physics: size, status bar and cutout at the top, gesture bar at the
 * bottom, and the back-gesture zones at the sides. Call again after a rotation, fold or inset change.
 */
public final class ScreenWorldProvider {
    /** Her window is this wide; the height follows the rig's 430:440 aspect. */
    public static final double BOX_WIDTH_DP = 140;
    /** A gesture zone wider than this would leave her too little room, so it is capped. */
    private static final double MAX_GESTURE_ZONE_DP = 48;
    /** Android 10 gesture navigation reserves about this much at each side; earlier versions reserve none. */
    private static final double GESTURE_ZONE_API_29_DP = 24;

    private ScreenWorldProvider() {
    }

    public static World measure(Context context) {
        double density = context.getResources().getDisplayMetrics().density;
        WindowManager windowManager = context.getSystemService(WindowManager.class);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowMetrics metrics = windowManager.getMaximumWindowMetrics();
            Rect bounds = metrics.getBounds();
            WindowInsets insets = metrics.getWindowInsets();
            Insets bars = insets.getInsetsIgnoringVisibility(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets gestures = insets.getInsets(WindowInsets.Type.systemGestures());
            return new World(bounds.width() / density, bounds.height() / density,
                    bars.top / density, bars.bottom / density, bars.left / density, bars.right / density,
                    Math.min(MAX_GESTURE_ZONE_DP, gestures.left / density),
                    Math.min(MAX_GESTURE_ZONE_DP, gestures.right / density),
                    BOX_WIDTH_DP, density);
        }
        return measureLegacy(context, windowManager, density);
    }

    @SuppressWarnings("deprecation")
    private static World measureLegacy(Context context, WindowManager windowManager, double density) {
        DisplayMetrics real = new DisplayMetrics();
        Display display = windowManager.getDefaultDisplay();
        display.getRealMetrics(real);
        double statusBar = dimension(context, "status_bar_height") / density;
        double navigationBar = dimension(context, "navigation_bar_height") / density;
        double zone = Build.VERSION.SDK_INT == 29 ? GESTURE_ZONE_API_29_DP : 0;
        return new World(real.widthPixels / density, real.heightPixels / density,
                statusBar, navigationBar, 0, 0, zone, zone, BOX_WIDTH_DP, density);
    }

    private static double dimension(Context context, String name) {
        int id = context.getResources().getIdentifier(name, "dimen", "android");
        return id > 0 ? context.getResources().getDimensionPixelSize(id) : 0;
    }
}
