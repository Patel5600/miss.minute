package com.patel5600.missminute.mobile.core;

/**
 * The screen as she sees it, in dp. Immutable: build a new one on rotation, fold or inset change.
 * The window is {@code boxW} wide with the rig's 430:440 aspect; her feet sit {@code footInset}
 * above the window's bottom edge.
 */
public final class World {
    public static final double RIG_WIDTH = 430;
    public static final double RIG_HEIGHT = 440;
    public static final double RIG_FOOT = 28;
    /** Half the width of the visible idle body, as a fraction of the window width. */
    public static final double BODY_HALF_WIDTH = 0.26;

    public final double screenW;
    public final double screenH;
    public final double insetTop;
    public final double insetBottom;
    public final double insetLeft;
    public final double insetRight;
    /** Width of the system back-gesture zone on each side. */
    public final double gestureLeft;
    public final double gestureRight;
    public final double density;
    public final double boxW;
    public final double boxH;
    public final double footInset;

    public World(double screenW, double screenH, double insetTop, double insetBottom,
                 double insetLeft, double insetRight, double gestureLeft, double gestureRight,
                 double boxW, double density) {
        this.screenW = screenW;
        this.screenH = screenH;
        this.insetTop = insetTop;
        this.insetBottom = insetBottom;
        this.insetLeft = insetLeft;
        this.insetRight = insetRight;
        this.gestureLeft = gestureLeft;
        this.gestureRight = gestureRight;
        this.boxW = boxW;
        this.boxH = Math.round(boxW * RIG_HEIGHT / RIG_WIDTH);
        this.footInset = boxH * RIG_FOOT / RIG_HEIGHT;
        this.density = density;
    }

    private double bodyHalf() {
        return BODY_HALF_WIDTH * boxW;
    }

    /** Window top when her feet stand on the floor line above the gesture bar. */
    public double floorTop() {
        return screenH - insetBottom - boxH + footInset;
    }

    /** Window top when she hangs at the top edge, below the status bar and cutout. */
    public double ceilTop() {
        return insetTop;
    }

    /** Smallest window left that keeps her body out of the left gesture zone. */
    public double minX() {
        return Math.max(0, insetLeft + gestureLeft) + bodyHalf() - boxW / 2;
    }

    /** Largest window left that keeps her body out of the right gesture zone. */
    public double maxX() {
        return screenW - Math.max(0, insetRight + gestureRight) - bodyHalf() - boxW / 2;
    }

    public boolean contains(double x, double y) {
        return x >= minX() - 1e-6 && x <= maxX() + 1e-6 && y >= ceilTop() - 1e-6 && y <= floorTop() + 1e-6;
    }
}