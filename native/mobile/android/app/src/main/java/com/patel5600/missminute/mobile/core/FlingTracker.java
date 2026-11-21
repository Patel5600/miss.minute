package com.patel5600.missminute.mobile.core;

/**
 * Finger velocity from screen coordinates, for throwing her. Android's VelocityTracker reads the
 * coordinates relative to the view, and her window moves with the finger, so the finger barely moves
 * relative to it and the velocity comes out as zero. This tracker is fed raw screen positions instead.
 *
 * <p>Like Android's tracker it only looks at the last {@link #HORIZON_MS} milliseconds and treats a
 * finger that has been still for {@link #STOPPED_MS} before the release as stopped.
 */
public final class FlingTracker {
    public static final long HORIZON_MS = 100;
    public static final long STOPPED_MS = 40;
    private static final int CAPACITY = 16;

    private final long[] times = new long[CAPACITY];
    private final double[] xs = new double[CAPACITY];
    private final double[] ys = new double[CAPACITY];
    private int count;
    private int next;

    public void clear() {
        count = 0;
        next = 0;
    }

    /** Adds one sample: the event time in milliseconds and the screen position in pixels. */
    public void add(long timeMs, double x, double y) {
        times[next] = timeMs;
        xs[next] = x;
        ys[next] = y;
        next = (next + 1) % CAPACITY;
        if (count < CAPACITY) {
            count++;
        }
    }

    /**
     * The velocity in pixels per second at {@code nowMs} (the release time): a least-squares line
     * through the samples of the last {@link #HORIZON_MS}. Zero with fewer than two usable samples or
     * when the finger stopped before the release.
     *
     * @return {vx, vy}
     */
    public double[] velocity(long nowMs) {
        if (count < 2) {
            return new double[] {0, 0};
        }
        int newest = (next - 1 + CAPACITY) % CAPACITY;
        long last = times[newest];
        if (nowMs - last > STOPPED_MS) {
            return new double[] {0, 0};
        }
        double sumT = 0;
        double sumX = 0;
        double sumY = 0;
        int n = 0;
        for (int i = 0; i < count; i++) {
            int index = (newest - i + CAPACITY) % CAPACITY;
            long age = last - times[index];
            if (age > HORIZON_MS) {
                break;
            }
            sumT += -age;
            sumX += xs[index];
            sumY += ys[index];
            n++;
        }
        if (n < 2) {
            return new double[] {0, 0};
        }
        double meanT = sumT / n;
        double meanX = sumX / n;
        double meanY = sumY / n;
        double tt = 0;
        double tx = 0;
        double ty = 0;
        for (int i = 0; i < n; i++) {
            int index = (newest - i + CAPACITY) % CAPACITY;
            double t = -(last - times[index]) - meanT;
            tt += t * t;
            tx += t * (xs[index] - meanX);
            ty += t * (ys[index] - meanY);
        }
        if (tt == 0) {
            return new double[] {0, 0};
        }
        return new double[] {tx / tt * 1000.0, ty / tt * 1000.0};
    }
}
