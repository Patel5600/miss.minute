package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

public class PhysicsTest {
    private final PhysicsConfig c = PhysicsConfig.defaults();
    private final World w = TestWorlds.portrait();
    private static final double STEP = 1.0 / 120.0;

    private BodyState midAirAtCeiling() {
        BodyState b = new BodyState((w.minX() + w.maxX()) / 2, w.ceilTop());
        b.locomotion = Locomotion.FALL;
        b.grounded = false;
        return b;
    }

    @Test
    public void freeFallTimeMatchesSqrt2hOverG() {
        BodyState b = midAirAtCeiling();
        double h = w.floorTop() - w.ceilTop();
        double expected = Math.sqrt(2 * h / c.gravity);
        double t = 0;
        double landedAt = -1;
        for (int i = 0; i < 1000 && landedAt < 0; i++) {
            List<Physics.Event> ev = Physics.advance(b, w, STEP, c);
            t += STEP;
            for (Physics.Event e : ev) {
                if (e.type == Physics.EventType.LANDED) {
                    landedAt = t;
                }
            }
        }
        assertTrue("never landed", landedAt > 0);
        assertEquals(expected, landedAt, STEP);
    }

    @Test
    public void landingReportsTheImpactSpeed() {
        BodyState b = midAirAtCeiling();
        double h = w.floorTop() - w.ceilTop();
        double expected = Math.sqrt(2 * c.gravity * h);
        double impact = -1;
        for (int i = 0; i < 1000 && impact < 0; i++) {
            for (Physics.Event e : Physics.advance(b, w, STEP, c)) {
                if (e.type == Physics.EventType.LANDED) {
                    impact = e.impact;
                }
            }
        }
        assertEquals(expected, impact, expected * 0.01);
    }

    @Test
    public void noTunnellingThroughTheFloorAtFlingSpeed() {
        BodyState b = new BodyState(100, w.floorTop() - 5);
        b.locomotion = Locomotion.THROWN;
        b.vy = c.flingClamp;
        List<Physics.Event> ev = Physics.advance(b, w, 1.0 / 30.0, c);
        assertTrue(b.y <= w.floorTop() + 1e-9);
        boolean landed = false;
        for (Physics.Event e : ev) {
            landed |= e.type == Physics.EventType.LANDED;
        }
        assertTrue(landed);
        assertTrue(w.contains(b.x, b.y));
    }

    @Test
    public void noTunnellingThroughAWallAtFlingSpeed() {
        BodyState b = new BodyState(w.maxX() - 5, 300);
        b.locomotion = Locomotion.THROWN;
        b.vx = c.flingClamp;
        List<Physics.Event> ev = Physics.advance(b, w, 1.0 / 30.0, c);
        assertTrue(b.x <= w.maxX() + 1e-9);
        boolean hit = false;
        for (Physics.Event e : ev) {
            hit |= e.type == Physics.EventType.HIT_WALL;
        }
        assertTrue(hit);
    }

    @Test
    public void wallBounceLosesEnergy() {
        BodyState b = new BodyState(w.maxX() - 1, 300);
        b.locomotion = Locomotion.THROWN;
        b.vx = 1000;
        b.vy = 0;
        Physics.step(b, w, STEP, c, new java.util.ArrayList<Physics.Event>());
        assertTrue(b.vx < 0);
        assertEquals(-1000 * c.wallRestitution, b.vx, 1.0);
        assertEquals(-1, b.facing);
    }

    @Test
    public void releaseUnder450IsADropAndOverIsAThrow() {
        BodyState b = new BodyState(100, 300);
        assertFalse(Physics.release(b, 300, 0, c));
        assertEquals(Locomotion.FALL, b.locomotion);
        assertEquals(0, b.vx, 0);
        assertEquals(0, b.vy, 0);
        assertFalse(b.grounded);

        assertTrue(Physics.release(b, 600, -200, c));
        assertEquals(Locomotion.THROWN, b.locomotion);
        assertEquals(600, b.vx, 1e-9);

        assertTrue(Physics.release(b, 9000, 0, c));
        assertEquals(c.flingClamp, Math.hypot(b.vx, b.vy), 1e-6);
    }

    @Test
    public void aDroppedBodySettlesOnTheFloorStanding() {
        BodyState b = midAirAtCeiling();
        boolean settled = false;
        boolean landed = false;
        for (int i = 0; i < 2000 && !settled; i++) {
            for (Physics.Event e : Physics.advance(b, w, STEP, c)) {
                settled |= e.type == Physics.EventType.SETTLED;
                landed |= e.type == Physics.EventType.LANDED;
            }
        }
        assertTrue(landed);
        assertTrue(settled);
        assertEquals(Locomotion.STAND, b.locomotion);
        assertTrue(b.grounded);
        assertEquals(w.floorTop(), b.y, 1e-9);
        assertEquals(0, b.vx, 0);
        assertEquals(0, b.vy, 0);
    }

    @Test
    public void aThrownBodySlidesToAStopBecauseOfFloorFriction() {
        BodyState b = new BodyState(60, w.floorTop() - 40);
        b.locomotion = Locomotion.THROWN;
        b.vx = 900;
        b.vy = 0;
        double travelled = 0;
        double startX = b.x;
        for (int i = 0; i < 4000 && b.locomotion != Locomotion.STAND; i++) {
            Physics.advance(b, w, STEP, c);
        }
        travelled = b.x - startX;
        assertEquals(Locomotion.STAND, b.locomotion);
        assertTrue(travelled > 50);
        assertTrue(w.contains(b.x, b.y));
    }

    @Test
    public void rotationClampsHerBackInsideAndAGroundedBodyFallsWhenTheFloorMoves() {
        World p = w;
        World l = TestWorlds.landscape();
        BodyState b = new BodyState(p.maxX(), p.floorTop());
        b.grounded = true;
        b.locomotion = Locomotion.STAND;
        assertTrue(Physics.clampToWorld(b, l));
        assertTrue(l.contains(b.x, b.y));
        assertEquals(l.floorTop(), b.y, 1e-9);

        // Back to portrait: the floor is now lower than she stands, so she falls to it.
        assertTrue(Physics.clampToWorld(b, p));
        assertFalse(b.grounded);
        assertEquals(Locomotion.FALL, b.locomotion);
        for (int i = 0; i < 2000 && b.locomotion != Locomotion.STAND; i++) {
            Physics.advance(b, p, STEP, c);
        }
        assertEquals(p.floorTop(), b.y, 1e-9);
    }

    @Test
    public void dragFollowsTheFingerAndStaysOnScreen() {
        BodyState b = new BodyState(100, 100);
        Physics.drag(b, w, -500, 5000);
        assertEquals(w.minX(), b.x, 1e-9);
        assertEquals(w.floorTop(), b.y, 1e-9);
        assertEquals(Locomotion.DRAGGED, b.locomotion);
    }

    @Test
    public void squashFollowsTheContractFormula() {
        assertEquals(0, c.squashFor(350), 0);
        assertEquals(0.15, c.squashFor(400), 1e-9);
        assertEquals(0.5, c.squashFor(1350), 1e-9);
        assertEquals(1.0, c.squashFor(5000), 1e-9);
    }

    @Test
    public void worldGeometryFollowsTheContract() {
        assertEquals(143, w.boxH, 0);
        assertEquals(143 * 28.0 / 440.0, w.footInset, 1e-9);
        assertEquals(915 - 24 - 143 + 143 * 28.0 / 440.0, w.floorTop(), 1e-9);
        assertEquals(40, w.ceilTop(), 0);
        assertTrue(w.minX() < w.maxX());
    }
}