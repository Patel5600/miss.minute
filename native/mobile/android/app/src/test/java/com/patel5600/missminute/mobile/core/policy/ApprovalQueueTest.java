package com.patel5600.missminute.mobile.core.policy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.core.Clock;
import org.junit.Test;

public class ApprovalQueueTest {
    private final long[] now = {5_000_000L};
    private final Clock clock = () -> now[0];

    @Test
    public void approveAndDenySettleOnce() {
        ApprovalQueue q = new ApprovalQueue(clock);
        ApprovalQueue.Approval a = q.add("open_app", "Open Calculator");
        ApprovalQueue.Approval b = q.add("delete_note", "Delete note \"Milk\"");
        assertNotEquals(a.id, b.id);
        assertEquals(2, q.list().size());
        assertEquals(ApprovalQueue.Result.APPROVED, q.decide(a.id, true));
        assertEquals(ApprovalQueue.Result.DENIED, q.decide(b.id, false));
        assertTrue(q.list().isEmpty());
        assertEquals(ApprovalQueue.Result.UNKNOWN, q.decide(a.id, true));
    }

    @Test
    public void approvalsExpireAfterTenMinutesAndCannotBeApproved() {
        ApprovalQueue q = new ApprovalQueue(clock);
        ApprovalQueue.Approval a = q.add("open_app", "Open Calculator");
        assertEquals(a.createdMs + 600_000L, a.expiresMs);
        now[0] += 599_999L;
        assertEquals(1, q.list().size());
        now[0] += 1;
        assertTrue(q.list().isEmpty());
        assertEquals(ApprovalQueue.Result.UNKNOWN, q.decide(a.id, true));

        ApprovalQueue.Approval b = q.add("open_app", "Open Clock");
        // Settling right at the deadline, before anything pruned the list, is also refused.
        now[0] += 600_000L;
        assertEquals(ApprovalQueue.Result.EXPIRED, q.decide(b.id, true));
    }

    @Test
    public void denyAllDropsEverythingAndCountsIt() {
        ApprovalQueue q = new ApprovalQueue(clock);
        q.add("a", "x");
        q.add("b", "y");
        q.add("c", "z");
        assertEquals(3, q.denyAll());
        assertTrue(q.list().isEmpty());
        assertEquals(0, q.denyAll());
    }

    @Test
    public void unknownIdsAreNeverApproved() {
        ApprovalQueue q = new ApprovalQueue(clock);
        q.add("a", "x");
        assertEquals(ApprovalQueue.Result.UNKNOWN, q.decide("ap0000000000000000", true));
        assertEquals(1, q.list().size());
    }
}