package com.patel5600.missminute.mobile.core.runtime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public final class CompanionRuntimeTest {
    @Test
    public void publishesStartRunStopWithMonotonicRevisions() {
        CompanionRuntime runtime = new CompanionRuntime();
        List<CompanionRuntime.Snapshot> events = new ArrayList<>();
        runtime.observe(events::add, false);

        runtime.requestStart();
        runtime.beginServiceInstance(false);
        runtime.markRunning();
        runtime.requestStop();
        runtime.markStopped();

        assertEquals(5, events.size());
        assertEquals(CompanionRuntime.State.STARTING, events.get(0).state);
        assertEquals(CompanionRuntime.State.STARTING, events.get(1).state);
        assertEquals(CompanionRuntime.State.RUNNING, events.get(2).state);
        assertEquals(CompanionRuntime.State.STOPPING, events.get(3).state);
        assertEquals(CompanionRuntime.State.STOPPED, events.get(4).state);

        long previousRevision = 0;
        String serviceInstance = null;
        for (CompanionRuntime.Snapshot event : events) {
            assertNotNull(event.eventId);
            assertNotNull(event.serviceInstanceId);
            assertNotEquals(event.eventId, event.serviceInstanceId);
            if (serviceInstance == null) serviceInstance = event.serviceInstanceId;
            assertEquals(serviceInstance, event.serviceInstanceId);
            if (event.revision <= previousRevision) {
                throw new AssertionError("revision did not increase");
            }
            previousRevision = event.revision;
        }
    }

    @Test
    public void processRecoveryHasAnObservableRecoveringState() {
        CompanionRuntime runtime = new CompanionRuntime();
        runtime.beginServiceInstance(true);
        assertEquals(CompanionRuntime.State.RECOVERING, runtime.snapshot().state);
        runtime.markRunning();
        assertEquals(CompanionRuntime.State.RUNNING, runtime.snapshot().state);
    }

    @Test
    public void permissionBlockAndFailureAreNotReportedAsStoppedSuccess() {
        CompanionRuntime runtime = new CompanionRuntime();
        runtime.requestStart();
        runtime.markPermissionBlocked("android.permission.SYSTEM_ALERT_WINDOW");
        assertEquals(CompanionRuntime.State.PERMISSION_BLOCKED, runtime.snapshot().state);
        assertEquals("android.permission.SYSTEM_ALERT_WINDOW", runtime.snapshot().reason);

        runtime.requestStart();
        runtime.markFailed("overlay_initialization_failed");
        assertEquals(CompanionRuntime.State.FAILED, runtime.snapshot().state);
        assertEquals("overlay_initialization_failed", runtime.snapshot().reason);
    }

    @Test
    public void rejectsImpossibleTransition() {
        CompanionRuntime runtime = new CompanionRuntime();
        assertThrows(IllegalStateException.class, runtime::markRunning);
    }

    @Test
    public void observerCanUnregister() {
        CompanionRuntime runtime = new CompanionRuntime();
        List<CompanionRuntime.Snapshot> events = new ArrayList<>();
        CompanionRuntime.Registration registration = runtime.observe(events::add, true);
        int initial = events.size();
        registration.unregister();
        runtime.requestStart();
        assertEquals(initial, events.size());
    }

    @Test
    public void duplicateStateIsIdempotent() {
        CompanionRuntime runtime = new CompanionRuntime();
        runtime.requestStart();
        long revision = runtime.snapshot().revision;
        runtime.requestStart();
        assertEquals(revision, runtime.snapshot().revision);
    }
}
