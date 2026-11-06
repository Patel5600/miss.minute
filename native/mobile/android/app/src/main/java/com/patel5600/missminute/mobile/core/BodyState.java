package com.patel5600.missminute.mobile.core;

/**
 * Where her overlay window is. x and y are the window's top-left corner in dp; vx and vy are in
 * dp per second, y grows downwards. Mutable: the loop owns one instance.
 */
public final class BodyState {
    public double x;
    public double y;
    public double vx;
    public double vy;
    /** -1 faces screen left, 1 faces screen right. */
    public int facing = 1;
    public Locomotion locomotion = Locomotion.STAND;
    public boolean grounded;

    public BodyState() {
    }

    public BodyState(double x, double y) {
        this.x = x;
        this.y = y;
    }

    public BodyState copy() {
        BodyState c = new BodyState(x, y);
        c.vx = vx;
        c.vy = vy;
        c.facing = facing;
        c.locomotion = locomotion;
        c.grounded = grounded;
        return c;
    }
}