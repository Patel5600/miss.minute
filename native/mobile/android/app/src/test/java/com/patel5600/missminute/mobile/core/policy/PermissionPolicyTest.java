package com.patel5600.missminute.mobile.core.policy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.patel5600.missminute.mobile.core.Clock;
import org.junit.Test;

public class PermissionPolicyTest {
    private static Decision d(Mode m, Capability c, Initiator i, boolean granted, int budget) {
        return PermissionPolicy.decide(m, c, i, granted, budget);
    }

    @Test
    public void propertiesHoldOverEveryModeCapabilityInitiatorGrantAndBudget() {
        int rows = 0;
        for (Mode mode : Mode.values()) {
            for (Capability cap : Capability.values()) {
                for (Initiator who : Initiator.values()) {
                    for (boolean granted : new boolean[] {false, true}) {
                        for (int budget : new int[] {0, 1}) {
                            rows++;
                            Decision r = d(mode, cap, who, granted, budget);
                            String row = mode + "/" + cap + "/" + who + "/" + granted + "/" + budget + " -> " + r;
                            if (r.isAllow() && mode == Mode.OBSERVE) {
                                assertEquals(row, Initiator.OWNER, who);
                            }
                            if (cap.risk == Risk.ALWAYS_ASK && who != Initiator.OWNER) {
                                assertFalse(row, r.isAllow());
                            }
                            if (who == Initiator.PROACTIVE && r.isAllow()) {
                                boolean automatic = mode == Mode.AUTHORIZED && granted && budget > 0;
                                assertTrue(row, cap == Capability.MEMORY_PROPOSE || automatic);
                            }
                            if (who == Initiator.MODEL && r.isAllow() && cap.risk == Risk.MEDIUM) {
                                assertTrue(row, mode == Mode.AUTHORIZED && granted && budget > 0);
                            }
                            if (!cap.availableOnAndroid) {
                                assertEquals(row, Decision.Outcome.DENY, r.outcome);
                                assertEquals(row, "unavailable_on_android", r.reason);
                            }
                            if (cap == Capability.MIC_CAPTURE && who != Initiator.OWNER) {
                                assertEquals(row, Decision.Outcome.DENY, r.outcome);
                            }
                            if (who == Initiator.OWNER && cap.availableOnAndroid) {
                                assertTrue(row, r.isAllow());
                            }
                        }
                    }
                }
            }
        }
        assertEquals(3 * 20 * 3 * 2 * 2, rows);
    }

    private static void check(Decision actual, Decision.Outcome outcome, String reason) {
        assertEquals(outcome, actual.outcome);
        assertEquals(reason, actual.reason);
    }

    @Test
    public void handPickedRows() {
        check(d(Mode.OBSERVE, Capability.NOTE_CREATE, Initiator.MODEL, false, 20), Decision.Outcome.DENY, "observe_mode");
        check(d(Mode.SUGGEST, Capability.TIMER_CREATE, Initiator.MODEL, false, 20), Decision.Outcome.ALLOW, "");
        check(d(Mode.SUGGEST, Capability.APP_OPEN, Initiator.MODEL, false, 20), Decision.Outcome.ASK, "needs_approval");
        check(d(Mode.SUGGEST, Capability.NOTE_DELETE, Initiator.MODEL, false, 20), Decision.Outcome.ASK, "always_ask");
        check(d(Mode.SUGGEST, Capability.TIMER_CREATE, Initiator.PROACTIVE, false, 20), Decision.Outcome.ASK,
                "proactive_needs_approval");
        check(d(Mode.AUTHORIZED, Capability.TIMER_CREATE, Initiator.PROACTIVE, true, 1), Decision.Outcome.ALLOW, "");
        check(d(Mode.AUTHORIZED, Capability.TIMER_CREATE, Initiator.PROACTIVE, true, 0), Decision.Outcome.ASK,
                "proactive_needs_approval");
        check(d(Mode.AUTHORIZED, Capability.TIMER_CREATE, Initiator.PROACTIVE, false, 5), Decision.Outcome.ASK,
                "proactive_needs_approval");
        check(d(Mode.SUGGEST, Capability.MEMORY_PROPOSE, Initiator.PROACTIVE, false, 0), Decision.Outcome.ALLOW, "");
        check(d(Mode.AUTHORIZED, Capability.APP_OPEN, Initiator.MODEL, true, 3), Decision.Outcome.ALLOW, "");
        check(d(Mode.AUTHORIZED, Capability.APP_OPEN, Initiator.PROACTIVE, true, 3), Decision.Outcome.ASK,
                "proactive_needs_approval");
        check(d(Mode.SUGGEST, Capability.MIC_CAPTURE, Initiator.MODEL, true, 3), Decision.Outcome.DENY, "owner_only");
        check(d(Mode.OBSERVE, Capability.MIC_CAPTURE, Initiator.OWNER, false, 0), Decision.Outcome.ALLOW, "");
        for (Mode m : Mode.values()) {
            for (Initiator i : Initiator.values()) {
                check(d(m, Capability.FILE_WRITE, i, true, 5), Decision.Outcome.DENY, "unavailable_on_android");
            }
        }
    }

    @Test
    public void permissionStateCannotBeMutatedThroughItsGrantSet() {
        PermissionState s = PermissionState.defaults();
        try {
            s.grants.add(Capability.APP_OPEN);
            fail("grants must be read-only");
        } catch (UnsupportedOperationException expected) {
            // good
        }
        PermissionState granted = s.withGrant(Capability.APP_OPEN, true);
        assertTrue(granted.isGranted(Capability.APP_OPEN));
        assertFalse(s.isGranted(Capability.APP_OPEN));
        assertEquals(Mode.SUGGEST, s.mode);
        assertFalse(s.proactive);
        assertFalse(s.shareWithRemote);
    }

    @Test
    public void autoBudgetAllows20PerRollingHour() {
        final long[] now = {1_000_000L};
        Clock clock = () -> now[0];
        AutoBudget b = new AutoBudget(clock);
        assertEquals(20, b.remaining());
        for (int i = 0; i < 20; i++) {
            assertTrue(b.tryConsume());
        }
        assertFalse(b.tryConsume());
        assertEquals(0, b.remaining());
        now[0] += 59 * 60_000L;
        assertEquals(0, b.remaining());
        now[0] += 60_000L + 1;
        assertEquals(20, b.remaining());
        assertTrue(b.tryConsume());
    }
}