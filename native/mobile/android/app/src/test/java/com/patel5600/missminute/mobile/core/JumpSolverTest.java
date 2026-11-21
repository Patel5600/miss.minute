package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class JumpSolverTest {
    private static final double G = 2600;
    private static final double MAX_RISE = 160;
    private static final double MAX_REACH = 260;

    /** Flies the launch with exact ballistics and returns x where she crosses y1 on the way down. */
    private static double landingX(double x0, double y0, double[] v, double y1) {
        double dt = 1.0 / 2000.0;
        double x = x0;
        double y = y0;
        double vx = v[0];
        double vy = v[1];
        for (int i = 0; i < 20000; i++) {
            double ny = y + vy * dt + 0.5 * G * dt * dt;
            double nvy = vy + G * dt;
            double nx = x + vx * dt;
            if (nvy > 0 && ny >= y1) {
                double f = (y1 - y) / (ny - y);
                return x + (nx - x) * f;
            }
            x = nx;
            y = ny;
            vy = nvy;
        }
        throw new AssertionError("never came down to the target");
    }

    @Test
    public void levelJumpLandsWithinTwoDp() {
        double[] v = JumpSolver.solve(60, 700, 260, 700, G, MAX_RISE, MAX_REACH);
        assertNotNull(v);
        assertEquals(260, landingX(60, 700, v, 700), 2.0);
    }

    @Test
    public void jumpUpToALedgeLandsWithinTwoDp() {
        double[] v = JumpSolver.solve(200, 700, 100, 620, G, MAX_RISE, MAX_REACH);
        assertNotNull(v);
        assertEquals(100, landingX(200, 700, v, 620), 2.0);
    }

    @Test
    public void jumpDownLandsWithinTwoDp() {
        double[] v = JumpSolver.solve(120, 300, 250, 700, G, MAX_RISE, MAX_REACH);
        assertNotNull(v);
        assertEquals(250, landingX(120, 300, v, 700), 2.0);
    }

    @Test
    public void solverLaunchLandsUnderTheRealPhysics() {
        World w = TestWorlds.portrait();
        PhysicsConfig c = PhysicsConfig.defaults();
        double x0 = 40;
        double x1 = 240;
        double[] v = JumpSolver.solve(x0, w.floorTop(), x1, w.floorTop(), c.gravity, MAX_RISE, MAX_REACH);
        assertNotNull(v);
        BodyState b = new BodyState(x0, w.floorTop());
        b.locomotion = Locomotion.JUMP;
        b.vx = v[0];
        b.vy = v[1];
        double landedX = Double.NaN;
        for (int i = 0; i < 2000 && Double.isNaN(landedX); i++) {
            for (Physics.Event e : Physics.advance(b, w, 1.0 / 120.0, c)) {
                if (e.type == Physics.EventType.LANDED && Double.isNaN(landedX)) {
                    landedX = b.x;
                }
            }
        }
        // The step that lands also moves x on to the end of the step, so allow vx * 1/120 (about 3.5 dp).
        assertEquals(x1, landedX, 4.0);
    }

    @Test
    public void returnsNullBeyondReachOrRise() {
        assertNull(JumpSolver.solve(0, 700, 300, 700, G, MAX_RISE, MAX_REACH));
        assertNull(JumpSolver.solve(100, 700, 150, 500, G, MAX_RISE, MAX_REACH));
    }
}