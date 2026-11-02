package com.patel5600.missminute.mobile.overlay;

import android.content.Context;
import android.graphics.PixelFormat;
import android.os.Build;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.widget.FrameLayout;

import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.core.World;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Her one window: a TYPE_APPLICATION_OVERLAY frame just big enough for her, so it never blocks the
 * rest of the screen. At most one exists per process: a second {@link #show()} while a window is up
 * does nothing (this is the duplicate-overlay bug from the desktop app). All touches are taken by the
 * frame, so the WebView inside it only draws.
 */
public final class OverlayWindow {
    private static final AtomicBoolean ADDED = new AtomicBoolean(false);

    private final WindowManager windowManager;
    private final TouchFrame root;
    private final WindowManager.LayoutParams params;
    private final float density;
    private boolean shown;

    public OverlayWindow(Context context, World world) {
        this.windowManager = context.getSystemService(WindowManager.class);
        this.density = (float) world.density;
        this.root = new TouchFrame(context);
        this.root.setContentDescription(context.getString(R.string.overlay_description));
        this.root.setImportantForAccessibility(FrameLayout.IMPORTANT_FOR_ACCESSIBILITY_YES);

        params = new WindowManager.LayoutParams(
                Math.round((float) (world.boxW * world.density)),
                Math.round((float) (world.boxH * world.density)),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.setTitle("MissMinutesOverlay");
        if (Build.VERSION.SDK_INT >= 28) {
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
    }

    /** The frame the WebView is added to. */
    public FrameLayout container() {
        return root;
    }

    public void setTouchListener(OverlayTouch.Listener listener) {
        root.touch = new OverlayTouch(root, density, listener);
    }

    /**
     * Adds the window to the screen.
     *
     * @return false when a window already exists in this process (nothing is added) or Android refused
     *         (for example the permission was taken away)
     */
    public boolean show() {
        if (shown) {
            return true;
        }
        if (!ADDED.compareAndSet(false, true)) {
            return false;
        }
        try {
            windowManager.addView(root, params);
            shown = true;
            return true;
        } catch (RuntimeException e) {
            ADDED.set(false);
            return false;
        }
    }

    /** Takes the window off the screen but keeps the view, so {@link #show()} can bring it back. */
    public void hide() {
        if (root.touch != null) {
            root.touch.cancel();
        }
        if (!shown) {
            return;
        }
        shown = false;
        ADDED.set(false);
        try {
            windowManager.removeViewImmediate(root);
        } catch (RuntimeException ignored) {
            // already gone
        }
    }

    public boolean isShown() {
        return shown;
    }

    /** True while any overlay window of this process is on screen. */
    public static boolean isAnyShown() {
        return ADDED.get();
    }

    /** Moves the window; does nothing when the rounded position is unchanged. */
    public void moveTo(int xPx, int yPx) {
        if (params.x == xPx && params.y == yPx) {
            return;
        }
        params.x = xPx;
        params.y = yPx;
        update();
    }

    public void resize(int widthPx, int heightPx) {
        if (params.width == widthPx && params.height == heightPx) {
            return;
        }
        params.width = widthPx;
        params.height = heightPx;
        update();
    }

    public int x() {
        return params.x;
    }

    public int y() {
        return params.y;
    }

    public int width() {
        return params.width;
    }

    public int height() {
        return params.height;
    }

    private void update() {
        if (!shown) {
            return;
        }
        try {
            windowManager.updateViewLayout(root, params);
        } catch (RuntimeException ignored) {
            // the view was detached while the update was queued
        }
    }

    /** Takes every touch for itself so the WebView below never receives one. */
    private static final class TouchFrame extends FrameLayout {
        OverlayTouch touch;

        TouchFrame(Context context) {
            super(context);
        }

        @Override
        public boolean onInterceptTouchEvent(MotionEvent event) {
            return true;
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            return touch != null && touch.onTouch(event);
        }

        @Override
        public boolean performClick() {
            return super.performClick();
        }
    }
}
