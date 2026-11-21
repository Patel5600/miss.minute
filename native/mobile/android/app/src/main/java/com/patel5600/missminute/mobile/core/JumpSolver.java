package com.patel5600.missminute.mobile.core;

/** Works out the launch velocity for a ballistic jump between two window positions. */
public final class JumpSolver {
    /** Extra height above the higher of start and target so she clears the landing spot. */
    private static final double CLEARANCE = 12;
    private static final double MIN_APEX = 30;

    private JumpSolver() {
    }

    /**
     * @param gravity  dp/s^2, positive down
     * @param maxRise  highest apex above the start she may reach (plan: 160)
     * @param maxReach widest horizontal distance (plan: 260)
     * @return {vx, vy} (vy negative is up), or null when the target is out of reach
     */
    public static double[] solve(double x0, double y0, double x1, double y1,
                                 double gravity, double maxRise, double maxReach) {
        double dx = x1 - x0;
        if (Math.abs(dx) > maxReach) {
            return null;
        }
        double up = y0 - y1; // positive when the target is higher than the start
        double apex = Math.max(up + CLEARANCE, MIN_APEX);
        if (apex > maxRise) {
            return null;
        }
        double vy = -Math.sqrt(2 * gravity * apex);
        double tUp = -vy / gravity;
        double fall = apex - up; // from the apex down to the target
        double tDown = Math.sqrt(2 * fall / gravity);
        double total = tUp + tDown;
        return new double[] {dx / total, vy};
    }
}