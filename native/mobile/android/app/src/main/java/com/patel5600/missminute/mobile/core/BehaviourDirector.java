package com.patel5600.missminute.mobile.core;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Picks what she does next: filters by level, rig capabilities, power and cooldowns, avoids
 * repeating herself, then makes a weighted pick from a seeded PRNG. Randomness chooses physical
 * behaviour only; it never chooses speech.
 */
public final class BehaviourDirector {
    public static final double MIN_WALK_DISTANCE = 80;
    public static final double JUMP_REACH = 260;
    private static final long NO_JUMP_AFTER_INTERACTION_MS = 20_000;
    private static final long NAP_AFTER_IDLE_MS = 120_000;
    private static final int GESTURE_MEMORY = 3;

    private final Mulberry32 rng;
    private final BehaviourCatalog catalog;
    private final Clock clock;
    private final Map<String, Long> lastChosenAt = new HashMap<>();
    private final Deque<String> recent = new ArrayDeque<>();
    private String lastId;

    public BehaviourDirector(long seed, BehaviourCatalog catalog, Clock clock) {
        this.rng = new Mulberry32(seed);
        this.catalog = catalog;
        this.clock = clock;
    }

    /** True from 23:00 to 06:00. */
    static boolean isNight(int hour) {
        return hour >= 23 || hour < 6;
    }

    /** Weight after the time-of-day rule. */
    public double weightOf(Behaviour b, DirectorContext ctx) {
        double w = b.weight;
        if (isNight(ctx.hourOfDay)) {
            switch (b.kind) {
                case NAP:
                    w *= 3;
                    break;
                case WALK:
                case RUN:
                case JUMP:
                case CLIMB:
                    w *= 0.4;
                    break;
                default:
                    break;
            }
        }
        return w;
    }

    private RoamingLevel effectiveLevel(DirectorContext ctx) {
        return RoamingLevel.min(ctx.level, ctx.power.levelCap);
    }

    /** Behaviours allowed by level, capabilities and power, before cooldown and anti-repeat. */
    public List<Behaviour> allowed(DirectorContext ctx) {
        List<Behaviour> out = new ArrayList<>();
        if (ctx.power.tier == PowerTier.PAUSED) {
            return out;
        }
        RoamingLevel level = effectiveLevel(ctx);
        for (Behaviour b : catalog.all()) {
            if (!level.atLeast(b.minLevel) || !ctx.capabilities.has(b.requires)) {
                continue;
            }
            if (ctx.power.tier != PowerTier.ACTIVE && !isCalmKind(b.kind)) {
                continue;
            }
            if (b.kind == Behaviour.Kind.JUMP
                    && (!ctx.power.allowJumps || ctx.msSinceInteraction < NO_JUMP_AFTER_INTERACTION_MS)) {
                continue;
            }
            if (b.kind == Behaviour.Kind.RUN && !ctx.power.allowRun) {
                continue;
            }
            if (b.kind == Behaviour.Kind.NAP && ctx.msSinceInteraction < NAP_AFTER_IDLE_MS) {
                continue;
            }
            if ((b.kind == Behaviour.Kind.WALK || b.kind == Behaviour.Kind.RUN || b.kind == Behaviour.Kind.JUMP)
                    && !hasRoom(ctx, MIN_WALK_DISTANCE)) {
                continue;
            }
            out.add(b);
        }
        return out;
    }

    private static boolean isCalmKind(Behaviour.Kind k) {
        return k == Behaviour.Kind.STAND || k == Behaviour.Kind.GESTURE || k == Behaviour.Kind.HOP
                || k == Behaviour.Kind.WALK || k == Behaviour.Kind.THINK;
    }

    /** Picks the next behaviour, or null while paused. */
    public BehaviourPlan choose(DirectorContext ctx) {
        List<Behaviour> allowed = allowed(ctx);
        if (allowed.isEmpty()) {
            return null;
        }
        long now = clock.nowMs();
        List<Behaviour> candidates = new ArrayList<>();
        double total = 0;
        for (Behaviour b : allowed) {
            if (b.id.equals(lastId)) {
                continue;
            }
            if (b.kind == Behaviour.Kind.GESTURE && recent.contains(b.id)) {
                continue;
            }
            Long last = lastChosenAt.get(b.id);
            if (last != null && now - last < b.cooldownMs) {
                continue;
            }
            candidates.add(b);
            total += weightOf(b, ctx);
        }
        Behaviour pick = null;
        if (candidates.isEmpty()) {
            // Everything is cooling down: stand quietly rather than repeat a move.
            pick = catalog.find("stand");
            if (pick == null || !allowed.contains(pick)) {
                pick = allowed.get(0);
            }
        } else {
            double r = rng.nextDouble() * total;
            for (Behaviour b : candidates) {
                r -= weightOf(b, ctx);
                if (r < 0) {
                    pick = b;
                    break;
                }
            }
            if (pick == null) {
                pick = candidates.get(candidates.size() - 1);
            }
        }
        remember(pick, now);
        return plan(pick, ctx);
    }

    private void remember(Behaviour b, long now) {
        lastId = b.id;
        lastChosenAt.put(b.id, now);
        if (b.kind == Behaviour.Kind.GESTURE) {
            recent.addLast(b.id);
            while (recent.size() > GESTURE_MEMORY) {
                recent.removeFirst();
            }
        }
    }

    /** Pause before the next behaviour: 0.8 to 2.5 s, 4 to 10 s docked, 40% shorter at WILD. */
    public long nextGapMs(RoamingLevel level) {
        if (level == RoamingLevel.DOCKED) {
            return Math.round(rng.range(4000, 10_000));
        }
        double gap = rng.range(800, 2500);
        if (level == RoamingLevel.WILD) {
            gap *= 0.6;
        }
        return Math.round(gap);
    }

    private double baseSpeed(RoamingLevel level) {
        switch (level) {
            case WILD:
                return 60;
            case LIVELY:
                return 48;
            default:
                return 34;
        }
    }

    private BehaviourPlan plan(Behaviour b, DirectorContext ctx) {
        World w = ctx.world;
        double x = ctx.body.x;
        RoamingLevel level = effectiveLevel(ctx);
        long duration = Math.round(rng.range(b.minDurationMs, b.maxDurationMs));
        switch (b.kind) {
            case WALK:
            case RUN: {
                double speed = (b.kind == Behaviour.Kind.RUN ? 120 : baseSpeed(level)) * ctx.power.speedScale;
                double target = awayTarget(w, x, MIN_WALK_DISTANCE, Double.POSITIVE_INFINITY);
                long ms = Math.round(Math.abs(target - x) / speed * 1000);
                ms = Math.max(b.minDurationMs, Math.min(b.maxDurationMs, ms));
                return new BehaviourPlan(b.id, b.kind, target, speed, ms, null);
            }
            case JUMP: {
                double target = awayTarget(w, x, MIN_WALK_DISTANCE, JUMP_REACH);
                return new BehaviourPlan(b.id, b.kind, Double.isNaN(target) ? x : target, 0, duration, null);
            }
            case HANG:
            case SIT_EDGE:
                return new BehaviourPlan(b.id, b.kind, rng.range(w.minX(), w.maxX()), 0, duration, null);
            case CLIMB:
            case PEEK:
                return new BehaviourPlan(b.id, b.kind, rng.chance(0.5) ? w.minX() : w.maxX(), 0, duration, null);
            case TELEPORT:
                return new BehaviourPlan(b.id, b.kind, awayTarget(w, x, 100, Double.POSITIVE_INFINITY), 0, duration, null);
            case THINK:
                return new BehaviourPlan(b.id, b.kind, x, 0, duration, "think");
            case GESTURE:
                return new BehaviourPlan(b.id, b.kind, x, 0, duration, b.gesture);
            default:
                return new BehaviourPlan(b.id, b.kind, x, 0, duration, null);
        }
    }

    private static boolean hasRoom(DirectorContext ctx, double minDist) {
        double x = ctx.body.x;
        return x - minDist >= ctx.world.minX() || x + minDist <= ctx.world.maxX();
    }

    /**
     * A target x at least {@code minDist} and at most {@code maxDist} from {@code x}, inside the
     * walkable range, uniform over the available length. NaN when there is no room.
     */
    private double awayTarget(World w, double x, double minDist, double maxDist) {
        double leftLo = Math.max(w.minX(), x - maxDist);
        double leftHi = x - minDist;
        double rightLo = x + minDist;
        double rightHi = Math.min(w.maxX(), x + maxDist);
        double leftLen = leftHi - leftLo;
        double rightLen = rightHi - rightLo;
        if (leftLen < 0 && rightLen < 0) {
            return Double.NaN;
        }
        boolean right;
        if (leftLen < 0) {
            right = true;
        } else if (rightLen < 0) {
            right = false;
        } else {
            double sum = leftLen + rightLen;
            right = sum <= 0 ? rng.chance(0.5) : rng.nextDouble() < rightLen / sum;
        }
        return right ? rng.range(rightLo, rightHi) : rng.range(leftLo, leftHi);
    }
}