package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.Test;

public class BehaviourDirectorTest {
    private static final class FakeClock implements Clock {
        long now = 1_000_000;

        @Override
        public long nowMs() {
            return now;
        }
    }

    private static final PowerDecision ACTIVE = PowerPolicy.decide(new PowerInputs(80, false, false, true, true, false));
    private static final PowerDecision SAVER = PowerPolicy.decide(new PowerInputs(80, false, true, true, true, false));
    private static final long LONG_AGO = 10 * 60_000L;

    private final World world = TestWorlds.portrait();
    private final BehaviourCatalog catalog = BehaviourCatalog.defaults();

    private DirectorContext ctx(RoamingLevel level, Capabilities caps, PowerDecision power) {
        return new DirectorContext(world, new BodyState(120, world.floorTop()), level, caps, power, 12, LONG_AGO);
    }

    private static final Set<String> GATED = new HashSet<>(Arrays.asList(
            "run", "sit-edge", "hang", "climb", "nap", "jump", "peek"));

    @Test
    public void sameSeedAndContextGiveTheSameGoldenFirst25Plans() {
        FakeClock clock = new FakeClock();
        BehaviourDirector d = new BehaviourDirector(19789, catalog, clock);
        DirectorContext c = ctx(RoamingLevel.WILD, Capabilities.all(), ACTIVE);
        List<String> actual = new ArrayList<>();
        for (int i = 0; i < 25; i++) {
            actual.add(String.valueOf(d.choose(c)));
            clock.now += 3000;
        }
        FakeClock clock2 = new FakeClock();
        BehaviourDirector again = new BehaviourDirector(19789, catalog, clock2);
        List<String> second = new ArrayList<>();
        for (int i = 0; i < 25; i++) {
            second.add(String.valueOf(again.choose(c)));
            clock2.now += 3000;
        }
        assertEquals(actual, second);
        assertEquals("golden list changed:\n" + String.join("\n", actual), GOLDEN, actual);
    }

    /** First 25 plans for seed 19789 at WILD with every capability, clock stepping 3 s. Regenerate only on purpose. */
    private static final List<String> GOLDEN = Arrays.asList(
            "sit-edge|x=241.1|v=0.0|11517ms",
            "gesture:think|x=120.0|v=0.0|3437ms",
            "gesture:hips|x=120.0|v=0.0|1620ms",
            "stand|x=120.0|v=0.0|4877ms",
            "gesture:wave|x=120.0|v=0.0|1845ms",
            "stand|x=120.0|v=0.0|2525ms",
            "walk|x=209.5|v=60.0|1500ms",
            "stand|x=120.0|v=0.0|3048ms",
            "gesture:point|x=120.0|v=0.0|3158ms",
            "climb|x=281.6|v=0.0|6091ms",
            "hang|x=265.3|v=0.0|5422ms",
            "run|x=211.5|v=120.0|800ms",
            "nap|x=120.0|v=0.0|28029ms",
            "hop|x=120.0|v=0.0|855ms",
            "gesture:knock|x=120.0|v=0.0|1593ms",
            "stand|x=120.0|v=0.0|5834ms",
            "jump|x=266.4|v=0.0|975ms",
            "gesture:shrug|x=120.0|v=0.0|2044ms",
            "peek|x=281.6|v=0.0|4596ms",
            "gesture:hips|x=120.0|v=0.0|3389ms",
            "walk|x=230.3|v=60.0|1839ms",
            "gesture:point|x=120.0|v=0.0|1587ms",
            "gesture:wave|x=120.0|v=0.0|1778ms",
            "gesture:clap|x=120.0|v=0.0|3118ms",
            "gesture:knock|x=120.0|v=0.0|2965ms");

    @Test
    public void dockedOnlyStandsAndGestures() {
        FakeClock clock = new FakeClock();
        BehaviourDirector d = new BehaviourDirector(5, catalog, clock);
        DirectorContext c = ctx(RoamingLevel.DOCKED, Capabilities.all(), ACTIVE);
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 2000; i++) {
            seen.add(d.choose(c).behaviourId);
            clock.now += 3000;
        }
        for (String id : seen) {
            assertTrue(id, id.equals("stand") || id.startsWith("gesture:"));
        }
        assertTrue(seen.size() > 3);
    }

    @Test
    public void baselineCapabilitiesNeverChooseGatedBehavioursAtWild() {
        FakeClock clock = new FakeClock();
        BehaviourDirector d = new BehaviourDirector(77, catalog, clock);
        DirectorContext c = ctx(RoamingLevel.WILD, Capabilities.baseline(), ACTIVE);
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 5000; i++) {
            seen.add(d.choose(c).behaviourId);
            clock.now += 3000;
        }
        for (String id : seen) {
            assertFalse("gated behaviour chosen without capability: " + id, GATED.contains(id));
        }
        assertTrue(seen.contains("walk"));
        assertTrue(seen.contains("hop"));
    }

    @Test
    public void gatedBehavioursAppearAtTheirMinimumLevelAndNeverBelow() {
        for (RoamingLevel level : RoamingLevel.values()) {
            FakeClock clock = new FakeClock();
            BehaviourDirector d = new BehaviourDirector(31 + level.ordinal(), catalog, clock);
            DirectorContext c = ctx(level, Capabilities.all(), ACTIVE);
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < 3000; i++) {
                seen.add(d.choose(c).behaviourId);
                clock.now += 3000;
            }
            for (Behaviour b : catalog.all()) {
                if (level.atLeast(b.minLevel)) {
                    assertTrue(level + " never chose " + b.id, seen.contains(b.id));
                } else {
                    assertFalse(level + " chose " + b.id + " below its minimum level", seen.contains(b.id));
                }
            }
        }
    }

    @Test
    public void saverAndLowBatteryNeverJumpOrRunAndStayCalm() {
        FakeClock clock = new FakeClock();
        BehaviourDirector d = new BehaviourDirector(9, catalog, clock);
        DirectorContext c = ctx(RoamingLevel.WILD, Capabilities.all(), SAVER);
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 3000; i++) {
            BehaviourPlan p = d.choose(c);
            seen.add(p.behaviourId);
            if (p.kind == Behaviour.Kind.WALK) {
                assertEquals(34 * 0.6, p.speed, 1e-9);
            }
            clock.now += 3000;
        }
        for (String id : seen) {
            assertTrue(id, id.equals("stand") || id.startsWith("gesture:") || id.equals("hop") || id.equals("walk"));
        }
        assertTrue(seen.contains("walk"));
    }

    @Test
    public void pausedPowerChoosesNothing() {
        PowerDecision paused = PowerPolicy.decide(new PowerInputs(80, false, false, false, false, false));
        BehaviourDirector d = new BehaviourDirector(1, catalog, new FakeClock());
        assertNull(d.choose(ctx(RoamingLevel.WILD, Capabilities.all(), paused)));
    }

    @Test
    public void noJumpSoonAfterATapAndNoNapUntilTwoMinutesIdle() {
        FakeClock clock = new FakeClock();
        BehaviourDirector d = new BehaviourDirector(4, catalog, clock);
        DirectorContext fresh = new DirectorContext(world, new BodyState(120, world.floorTop()), RoamingLevel.WILD,
                Capabilities.all(), ACTIVE, 12, 5_000);
        for (int i = 0; i < 3000; i++) {
            String id = d.choose(fresh).behaviourId;
            assertFalse(id, id.equals("jump") || id.equals("nap"));
            clock.now += 3000;
        }
    }

    @Test
    public void cooldownsAndAntiRepeatHold() {
        FakeClock clock = new FakeClock();
        BehaviourDirector d = new BehaviourDirector(123, catalog, clock);
        DirectorContext c = ctx(RoamingLevel.WILD, Capabilities.all(), ACTIVE);
        Map<String, Long> last = new HashMap<>();
        List<String> history = new ArrayList<>();
        String previous = null;
        for (int i = 0; i < 4000; i++) {
            String id = d.choose(c).behaviourId;
            assertFalse("same id twice in a row: " + id, id.equals(previous));
            Behaviour b = catalog.find(id);
            Long at = last.get(id);
            if (at != null) {
                assertTrue(id + " picked after " + (clock.now - at) + " ms", clock.now - at >= b.cooldownMs);
            }
            if (b.kind == Behaviour.Kind.GESTURE) {
                int from = Math.max(0, history.size() - 3);
                for (String h : history.subList(from, history.size())) {
                    assertFalse("gesture repeated within 3 gesture picks: " + id, h.equals(id));
                }
                history.add(id);
            }
            last.put(id, clock.now);
            previous = id;
            clock.now += 100;
        }
    }

    @Test
    public void walkTargetsStayInsideTheRangeAndAtLeast80DpAway() {
        FakeClock clock = new FakeClock();
        BehaviourDirector d = new BehaviourDirector(2024, catalog, clock);
        for (double x : new double[] {world.minX(), 40, 120, 200, world.maxX()}) {
            DirectorContext c = new DirectorContext(world, new BodyState(x, world.floorTop()), RoamingLevel.WILD,
                    Capabilities.all(), ACTIVE, 12, LONG_AGO);
            int walks = 0;
            for (int i = 0; i < 1500; i++) {
                BehaviourPlan p = d.choose(c);
                if (p.kind == Behaviour.Kind.WALK || p.kind == Behaviour.Kind.RUN) {
                    walks++;
                    assertTrue(p.targetX >= world.minX() - 1e-9 && p.targetX <= world.maxX() + 1e-9);
                    assertTrue("target " + p.targetX + " from " + x, Math.abs(p.targetX - x) >= 80 - 1e-9);
                    assertTrue(p.speed > 0);
                }
                clock.now += 3000;
            }
            assertTrue(walks > 0);
        }
    }

    @Test
    public void weightsShareEachPickWithinTwoPercentagePoints() {
        DirectorContext c = ctx(RoamingLevel.WILD, Capabilities.all(), ACTIVE);
        List<Behaviour> allowed = new BehaviourDirector(0, catalog, new FakeClock()).allowed(c);
        double total = 0;
        for (Behaviour b : allowed) {
            total += b.weight;
        }
        assertEquals(63.0, total, 1e-9);
        Map<String, Integer> counts = new HashMap<>();
        int picks = 10_000;
        for (int i = 0; i < picks; i++) {
            // A fresh director per pick has no history, so the share is exactly weight / total.
            BehaviourDirector d = new BehaviourDirector(1000 + i, catalog, new FakeClock());
            String id = d.choose(c).behaviourId;
            Integer n = counts.get(id);
            counts.put(id, n == null ? 1 : n + 1);
        }
        for (Behaviour b : allowed) {
            double expected = b.weight / total;
            Integer n = counts.get(b.id);
            double actual = (n == null ? 0 : n) / (double) picks;
            assertEquals(b.id, expected, actual, 0.02);
        }
    }

    @Test
    public void nightShiftsWeightsTowardNapsAndAwayFromTravel() {
        BehaviourDirector d = new BehaviourDirector(0, catalog, new FakeClock());
        DirectorContext night = new DirectorContext(world, new BodyState(120, world.floorTop()), RoamingLevel.WILD,
                Capabilities.all(), ACTIVE, 23, LONG_AGO);
        DirectorContext day = ctx(RoamingLevel.WILD, Capabilities.all(), ACTIVE);
        assertEquals(6.0, d.weightOf(catalog.find("nap"), night), 1e-9);
        assertEquals(8 * 0.4, d.weightOf(catalog.find("walk"), night), 1e-9);
        assertEquals(10.0, d.weightOf(catalog.find("stand"), night), 1e-9);
        assertEquals(2.0, d.weightOf(catalog.find("nap"), day), 1e-9);
        assertNotNull(catalog.find("peek"));
    }

    @Test
    public void gapsFollowTheContract() {
        BehaviourDirector d = new BehaviourDirector(3, catalog, new FakeClock());
        for (int i = 0; i < 500; i++) {
            long calm = d.nextGapMs(RoamingLevel.CALM);
            assertTrue(calm >= 800 && calm <= 2500);
            long docked = d.nextGapMs(RoamingLevel.DOCKED);
            assertTrue(docked >= 4000 && docked <= 10_000);
            long wild = d.nextGapMs(RoamingLevel.WILD);
            assertTrue(wild >= 480 && wild <= 1500);
        }
    }
}