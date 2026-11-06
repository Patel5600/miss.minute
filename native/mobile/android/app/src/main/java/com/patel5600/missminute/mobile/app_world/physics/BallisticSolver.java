package com.patel5600.missminute.mobile.app_world.physics;

/**
 * Solves real 2D ballistic parabolic jump trajectories between two arbitrary coordinates
 * adhering to the laws of physical motion:
 *   r(t) = r_0 + v_0 * t + 0.5 * a * t^2
 */
public final class BallisticSolver {
    public static final double DEFAULT_GRAVITY = 1800.0; // dp/s^2
    public static final double MIN_APEX_HEIGHT = 45.0;   // dp
    public static final double MAX_REACH_DISTANCE = 850.0; // dp
    public static final double MAX_FLIGHT_TIME = 2.5;     // seconds

    public static final class TrajectoryPlan {
        public final double x0;
        public final double y0;
        public final double xd;
        public final double yd;
        public final double vx0;
        public final double vy0;
        public final double gravity;
        public final double duration;
        public final double apexY;
        public final double impactVy;
        public final double estimatedSquash;

        public TrajectoryPlan(double x0, double y0, double xd, double yd,
                              double vx0, double vy0, double gravity,
                              double duration, double apexY, double impactVy,
                              double estimatedSquash) {
            this.x0 = x0;
            this.y0 = y0;
            this.xd = xd;
            this.yd = yd;
            this.vx0 = vx0;
            this.vy0 = vy0;
            this.gravity = gravity;
            this.duration = duration;
            this.apexY = apexY;
            this.impactVy = impactVy;
            this.estimatedSquash = estimatedSquash;
        }

        /**
         * Computes the exact position [x, y] in dp at time t (seconds).
         */
        public float[] samplePosition(double t) {
            double clampedT = Math.max(0.0, Math.min(duration, t));
            double x = x0 + vx0 * clampedT;
            double y = y0 + vy0 * clampedT + 0.5 * gravity * clampedT * clampedT;
            return new float[]{(float) x, (float) y};
        }

        /**
         * Computes the velocity [vx, vy] in dp/s at time t (seconds).
         */
        public float[] sampleVelocity(double t) {
            double clampedT = Math.max(0.0, Math.min(duration, t));
            double vx = vx0;
            double vy = vy0 + gravity * clampedT;
            return new float[]{(float) vx, (float) vy};
        }
    }

    private BallisticSolver() {
    }

    /**
     * Solves the initial velocities and parameters required to jump from (x0, y0) to (xd, yd).
     *
     * @param x0       Start x in dp.
     * @param y0       Start y in dp.
     * @param xd       Target x in dp.
     * @param yd       Target y in dp.
     * @param gravity  Downward acceleration in dp/s^2.
     * @param minY     Screen ceiling or highest permissible y coordinate in dp.
     * @return TrajectoryPlan if physically reachable, null otherwise.
     */
    public static TrajectoryPlan solve(double x0, double y0, double xd, double yd,
                                       double gravity, double minY) {
        if (gravity <= 0) {
            gravity = DEFAULT_GRAVITY;
        }

        double dx = xd - x0;
        double dy = yd - y0;
        double distance = Math.hypot(dx, dy);

        if (distance > MAX_REACH_DISTANCE) {
            return null; // out of jump reach
        }

        // Higher targets or longer distance jumps need higher apex
        double baseApexRise = Math.max(MIN_APEX_HEIGHT, Math.min(220.0, Math.abs(dx) * 0.35 + 30.0));
        double targetApexY = Math.min(y0, yd) - baseApexRise;

        // Ensure apex doesn't pierce through the top of the screen
        if (targetApexY < minY + 10.0) {
            targetApexY = minY + 10.0;
        }

        // Check if destination or start is above allowed apex
        if (targetApexY >= y0 || targetApexY >= yd) {
            targetApexY = Math.min(y0, yd) - 15.0;
        }

        double riseToApex = y0 - targetApexY;
        double fallFromApex = yd - targetApexY;

        if (riseToApex <= 0 || fallFromApex <= 0) {
            return null;
        }

        // v_0y = -sqrt(2 * g * rise)
        double vy0 = -Math.sqrt(2.0 * gravity * riseToApex);
        double t1 = -vy0 / gravity;
        double t2 = Math.sqrt(2.0 * fallFromApex / gravity);
        double totalTime = t1 + t2;

        if (totalTime <= 0 || totalTime > MAX_FLIGHT_TIME) {
            return null;
        }

        double vx0 = dx / totalTime;
        double impactVy = vy0 + gravity * totalTime;

        // Momentum dissipated into physical squash: clamp between 0.15 and 0.8
        double squash = Math.max(0.15, Math.min(0.85, (Math.abs(impactVy) / 1000.0) * 0.65));

        return new TrajectoryPlan(x0, y0, xd, yd, vx0, vy0, gravity, totalTime, targetApexY, impactVy, squash);
    }
}
