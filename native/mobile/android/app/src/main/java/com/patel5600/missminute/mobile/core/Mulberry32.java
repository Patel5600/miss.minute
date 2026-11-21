package com.patel5600.missminute.mobile.core;

/**
 * mulberry32 PRNG, bit-for-bit the same sequence as {@code createRandom} in
 * src/character/rig/math.ts (checked against tests/android/vectors/rng.json).
 */
public final class Mulberry32 {
    private int state;

    public Mulberry32(long seed) {
        this.state = (int) seed;
    }

    /** Next double in [0, 1). */
    public double nextDouble() {
        state += 0x6d2b79f5;
        int t = state;
        t = (t ^ (t >>> 15)) * (t | 1);
        t ^= t + (t ^ (t >>> 7)) * (t | 61);
        return ((t ^ (t >>> 14)) & 0xFFFFFFFFL) / 4294967296.0;
    }

    /** Integer in [0, bound). */
    public int nextInt(int bound) {
        if (bound <= 0) {
            throw new IllegalArgumentException("bound must be positive");
        }
        return (int) (nextDouble() * bound);
    }

    /** Double in [lo, hi). */
    public double range(double lo, double hi) {
        return lo + (hi - lo) * nextDouble();
    }

    public boolean chance(double probability) {
        return nextDouble() < probability;
    }
}