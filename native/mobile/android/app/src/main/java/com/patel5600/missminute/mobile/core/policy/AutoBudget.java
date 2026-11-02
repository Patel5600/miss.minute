package com.patel5600.missminute.mobile.core.policy;

import com.patel5600.missminute.mobile.core.Clock;
import java.util.ArrayDeque;
import java.util.Deque;

/** Automatic actions allowed per rolling hour (20). Thread-safe. */
public final class AutoBudget {
    public static final int LIMIT_PER_HOUR = 20;
    private static final long WINDOW_MS = 60L * 60L * 1000L;

    private final Clock clock;
    private final int limit;
    private final Deque<Long> used = new ArrayDeque<>();

    public AutoBudget(Clock clock) {
        this(clock, LIMIT_PER_HOUR);
    }

    public AutoBudget(Clock clock, int limit) {
        this.clock = clock;
        this.limit = limit;
    }

    private void prune() {
        long cutoff = clock.nowMs() - WINDOW_MS;
        while (!used.isEmpty() && used.peekFirst() <= cutoff) {
            used.removeFirst();
        }
    }

    public synchronized int remaining() {
        prune();
        return Math.max(0, limit - used.size());
    }

    /** Spends one automatic action. False when the hour's budget is gone. */
    public synchronized boolean tryConsume() {
        prune();
        if (used.size() >= limit) {
            return false;
        }
        used.addLast(clock.nowMs());
        return true;
    }
}