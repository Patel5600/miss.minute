package com.patel5600.missminute.mobile.core;

import java.util.ArrayList;
import java.util.List;

/**
 * Gravity, bounces, floor friction and fling for her window. Stateless: everything lives in the
 * {@link BodyState}. Positions are clamped to the world, so nothing tunnels at fling speeds.
 * Integration is exact for constant gravity, so a {@link JumpSolver} launch lands where it says.
 */
public final class Physics {
    public enum EventType { LANDED, HIT_WALL, SETTLED }

    public static final class Event {
        public final EventType type;
        /** Speed into the surface just before the bounce, in dp/s (0 for SETTLED). */
        public final double impact;

        Event(EventType type, double impact) {
            this.type = type;
            this.impact = impact;
        }
    }

    private Physics() {
    }

    /** Runs one frame of {@code dt} seconds as up to 8 steps of at most 1/120 s. */
    public static List<Event> advance(BodyState b, World w, double dt, PhysicsConfig c) {
        List<Event> events = new ArrayList<>();
        double frame = Math.min(Math.max(dt, 0), c.maxStepsPerFrame * c.stepSeconds);
        int steps = Math.max(1, (int) Math.ceil(frame / c.stepSeconds - 1e-9));
        double h = frame / steps;
        if (frame <= 0) {
            return events;
        }
        for (int i = 0; i < steps; i++) {
            step(b, w, h, c, events);
        }
        return events;
    }

    /** One fixed step. Events are appended to {@code out}. */
    public static void step(BodyState b, World w, double dt, PhysicsConfig c, List<Event> out) {
        double floor = w.floorTop();
        double ceil = w.ceilTop();
        double minX = w.minX();
        double maxX = w.maxX();

        if (b.locomotion.isSpecialKind()) {
            return; // TELEPORT and THINK have no physics
        }
        if (!b.locomotion.isAirborneKind()) {
            return; // standing, walking, dragged, hanging and so on are moved by their own controllers
        }

        if (!b.grounded) {
            double vy0 = b.vy;
            double vy1 = Math.min(vy0 + c.gravity * dt, c.maxFallSpeed);
            double dy = vy1 >= c.maxFallSpeed && vy0 < c.maxFallSpeed
                    ? (c.maxFallSpeed * c.maxFallSpeed - vy0 * vy0) / (2 * c.gravity)
                      + c.maxFallSpeed * (dt - (c.maxFallSpeed - vy0) / c.gravity)
                    : (vy0 + vy1) / 2 * dt;
            b.y += dy;
            b.vy = vy1;
        }
        b.x += b.vx * dt;

        if (b.x < minX) {
            hitWall(b, minX, c, out);
        } else if (b.x > maxX) {
            hitWall(b, maxX, c, out);
        }
        if (b.y < ceil) {
            b.y = ceil;
            if (b.vy < 0) {
                b.vy = -b.vy * c.wallRestitution;
            }
        }

        if (!b.grounded && b.y >= floor) {
            double impact = Math.max(0, b.vy);
            b.y = floor;
            double bounce = impact * c.floorRestitution;
            if (bounce < c.settleSpeed) {
                b.vy = 0;
                b.grounded = true;
            } else {
                b.vy = -bounce;
            }
            out.add(new Event(EventType.LANDED, impact));
        }

        if (b.grounded) {
            b.y = floor;
            b.vy = 0;
            double drop = c.floorFriction * dt;
            if (Math.abs(b.vx) <= drop) {
                b.vx = 0;
            } else {
                b.vx -= Math.signum(b.vx) * drop;
            }
            if (b.vx == 0) {
                b.locomotion = Locomotion.STAND;
                out.add(new Event(EventType.SETTLED, 0));
            }
        }
        if (b.vx != 0) {
            b.facing = b.vx < 0 ? -1 : 1;
        }
    }

    private static void hitWall(BodyState b, double wallX, PhysicsConfig c, List<Event> out) {
        double speed = Math.abs(b.vx);
        b.x = wallX;
        b.vx = -b.vx * c.wallRestitution;
        out.add(new Event(EventType.HIT_WALL, speed));
    }

    /** She follows the finger. Clamped to the screen so she cannot be lost off an edge. */
    public static void drag(BodyState b, World w, double x, double y) {
        b.x = clamp(x, w.minX(), w.maxX());
        b.y = clamp(y, w.ceilTop(), w.floorTop());
        b.vx = 0;
        b.vy = 0;
        b.grounded = false;
        b.locomotion = Locomotion.DRAGGED;
    }

    /**
     * Lets go with the finger's velocity. At least 450 dp/s is a throw (speed clamped to 5200);
     * anything slower is a drop that just falls.
     *
     * @return true for a throw
     */
    public static boolean release(BodyState b, double vx, double vy, PhysicsConfig c) {
        double speed = Math.hypot(vx, vy);
        b.grounded = false;
        if (speed >= c.throwThreshold) {
            double k = speed > c.flingClamp ? c.flingClamp / speed : 1;
            b.vx = vx * k;
            b.vy = vy * k;
            b.locomotion = Locomotion.THROWN;
            return true;
        }
        b.vx = 0;
        b.vy = 0;
        b.locomotion = Locomotion.FALL;
        return false;
    }

    /**
     * Brings her back inside after the world changed (rotation, fold, insets).
     *
     * @return true if anything moved
     */
    public static boolean clampToWorld(BodyState b, World w) {
        double nx = clamp(b.x, w.minX(), w.maxX());
        double ny = clamp(b.y, w.ceilTop(), w.floorTop());
        boolean moved = nx != b.x || ny != b.y;
        b.x = nx;
        b.y = ny;
        if (b.grounded && b.y < w.floorTop() - 0.5) {
            // The floor moved down under her: she falls to it.
            b.grounded = false;
            b.locomotion = Locomotion.FALL;
            b.vy = 0;
            moved = true;
        }
        return moved;
    }

    private static double clamp(double v, double lo, double hi) {
        if (hi < lo) {
            return lo;
        }
        return v < lo ? lo : (v > hi ? hi : v);
    }
}