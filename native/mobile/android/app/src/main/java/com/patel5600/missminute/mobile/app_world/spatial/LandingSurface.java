package com.patel5600.missminute.mobile.app_world.spatial;

import android.graphics.RectF;
import com.patel5600.missminute.mobile.core.Locomotion;

/**
 * Geometric landing surfaces and virtual attachment points on application icons.
 * All coordinate math is computed in display-independent pixels (dp).
 */
public enum LandingSurface {
    /** Feet or body positioned on the upper boundary with legs dangling over the edge. */
    TOP,

    /** Hands gripping beneath the lower edge of the icon. */
    BOTTOM,

    /** Gripping vertical left side for climbing. */
    LEFT,

    /** Gripping vertical right side for climbing. */
    RIGHT,

    /** Stable top-left corner perch. */
    TOP_LEFT,

    /** Stable top-right corner perch. */
    TOP_RIGHT,

    /** Peeking or hiding behind the icon body. */
    CENTER;

    /**
     * Calculates the window top-left position (x, y) in dp so that Miss Minutes's body
     * attaches correctly to the specified landing surface of the icon bounds.
     *
     * @param bounds     Application icon bounding box in dp.
     * @param charBoxW   Character window width in dp.
     * @param charBoxH   Character window height in dp.
     * @param footInset  Distance from character window bottom to foot line in dp.
     * @return float[2] { windowX, windowY } in dp.
     */
    public float[] calculateAttachment(RectF bounds, double charBoxW, double charBoxH, double footInset) {
        float x;
        float y;
        float centerX = bounds.centerX();
        float centerY = bounds.centerY();

        switch (this) {
            case TOP:
                // Her feet stand right on the top edge of the icon; legs dangle downward.
                x = (float) (centerX - charBoxW / 2.0);
                y = (float) (bounds.top - charBoxH + footInset);
                break;

            case BOTTOM:
                // Character hangs right under the bottom edge of the icon.
                x = (float) (centerX - charBoxW / 2.0);
                y = bounds.bottom;
                break;

            case LEFT:
                // Gripping left edge of icon.
                x = (float) (bounds.left - charBoxW * 0.7);
                y = (float) (centerY - charBoxH / 2.0);
                break;

            case RIGHT:
                // Gripping right edge of icon.
                x = (float) (bounds.right - charBoxW * 0.3);
                y = (float) (centerY - charBoxH / 2.0);
                break;

            case TOP_LEFT:
                // Perched on top-left corner.
                x = (float) (bounds.left - charBoxW * 0.45);
                y = (float) (bounds.top - charBoxH + footInset);
                break;

            case TOP_RIGHT:
                // Perched on top-right corner.
                x = (float) (bounds.right - charBoxW * 0.55);
                y = (float) (bounds.top - charBoxH + footInset);
                break;

            case CENTER:
            default:
                // Peeking / centered behind the icon.
                x = (float) (centerX - charBoxW / 2.0);
                y = (float) (centerY - charBoxH / 2.0);
                break;
        }

        return new float[]{x, y};
    }

    /**
     * Recommended locomotion animation for this landing surface.
     */
    public Locomotion defaultLocomotion() {
        switch (this) {
            case TOP:
            case TOP_LEFT:
            case TOP_RIGHT:
                return Locomotion.SIT_EDGE;
            case BOTTOM:
                return Locomotion.HANG;
            case LEFT:
            case RIGHT:
                return Locomotion.CLIMB;
            case CENTER:
                return Locomotion.PEEK;
            default:
                return Locomotion.STAND;
        }
    }
}
