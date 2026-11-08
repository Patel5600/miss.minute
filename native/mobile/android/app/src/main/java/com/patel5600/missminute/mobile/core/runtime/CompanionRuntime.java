package com.patel5600.missminute.mobile.core.runtime;

import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Process-local authoritative state for the Android foreground companion service.
 * Every published transition has a unique event ID, service-instance ID, monotonic
 * timestamp, and strictly increasing process revision.
 */
public final class CompanionRuntime {
    public enum State {
        STOPPED,
        STARTING,
        RUNNING,
        STOPPING,
        FAILED,
        PERMISSION_BLOCKED,
        RECOVERING
    }

    public interface Listener {
        void onChanged(Snapshot snapshot);
    }

    public interface Registration {
        void unregister();
    }

    private final Object lock = new Object();
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private long revision;
    private String serviceInstanceId;
    private Snapshot current = new Snapshot(
            UUID.randomUUID().toString(), null, 0, System.nanoTime(), State.STOPPED, null);

    public Snapshot snapshot() {
        synchronized (lock) {
            return current;
        }
    }

    public Registration observe(final Listener listener, boolean emitCurrent) {
        if (listener == null) throw new IllegalArgumentException("listener is required");
        listeners.addIfAbsent(listener);
        if (emitCurrent) deliver(listener, snapshot());
        return () -> listeners.remove(listener);
    }

    /** Called exactly once by each new Android Service instance. */
    public Snapshot beginServiceInstance(boolean recovering) {
        synchronized (lock) {
            serviceInstanceId = UUID.randomUUID().toString();
        }
        return publish(recovering ? State.RECOVERING : State.STARTING, null, true);
    }

    /** An explicit user start request, before Android invokes Service.onCreate(). */
    public Snapshot requestStart() {
        State state = snapshot().state;
        if (state == State.STARTING || state == State.RUNNING || state == State.RECOVERING) {
            return snapshot();
        }
        return publish(State.STARTING, null, false);
    }

    public Snapshot markRecovering() {
        return publish(State.RECOVERING, null, false);
    }

    public Snapshot markRunning() {
        return publish(State.RUNNING, null, false);
    }

    public Snapshot requestStop() {
        State state = snapshot().state;
        if (state == State.STOPPED || state == State.FAILED || state == State.PERMISSION_BLOCKED) {
            return snapshot();
        }
        return publish(State.STOPPING, null, false);
    }

    public Snapshot markStopped() {
        return publish(State.STOPPED, null, false);
    }

    public Snapshot markFailed(String reason) {
        return publish(State.FAILED, safeReason(reason), false);
    }

    public Snapshot markPermissionBlocked(String permission) {
        return publish(State.PERMISSION_BLOCKED, safeReason(permission), false);
    }

    private Snapshot publish(State next, String reason, boolean newInstance) {
        final Snapshot updated;
        synchronized (lock) {
            if (!newInstance && current.state == next && equal(current.reason, reason)) {
                return current;
            }
            if (!allowed(current.state, next)) {
                throw new IllegalStateException("illegal companion transition " + current.state + " -> " + next);
            }
            revision++;
            updated = new Snapshot(
                    UUID.randomUUID().toString(),
                    serviceInstanceId,
                    revision,
                    System.nanoTime(),
                    next,
                    reason);
            current = updated;
        }
        for (Listener listener : listeners) deliver(listener, updated);
        return updated;
    }

    private static boolean allowed(State from, State to) {
        switch (from) {
            case STOPPED:
                return to == State.STARTING || to == State.PERMISSION_BLOCKED || to == State.FAILED;
            case STARTING:
                return to == State.RUNNING || to == State.STOPPING || to == State.FAILED
                        || to == State.PERMISSION_BLOCKED || to == State.RECOVERING || to == State.STOPPED;
            case RUNNING:
                return to == State.STOPPING || to == State.FAILED
                        || to == State.PERMISSION_BLOCKED || to == State.RECOVERING || to == State.STOPPED;
            case STOPPING:
                return to == State.STOPPED || to == State.FAILED || to == State.STARTING;
            case FAILED:
                return to == State.STARTING || to == State.STOPPED
                        || to == State.RECOVERING || to == State.PERMISSION_BLOCKED;
            case PERMISSION_BLOCKED:
                return to == State.STARTING || to == State.STOPPED;
            case RECOVERING:
                return to == State.RUNNING || to == State.STARTING || to == State.STOPPING
                        || to == State.FAILED || to == State.PERMISSION_BLOCKED || to == State.STOPPED;
            default:
                return false;
        }
    }

    private static String safeReason(String value) {
        if (value == null || value.isEmpty()) return "unspecified";
        String safe = value.replaceAll("[^A-Za-z0-9._:/-]", "_");
        return safe.substring(0, Math.min(safe.length(), 96));
    }

    private static boolean equal(Object a, Object b) {
        return a == null ? b == null : a.equals(b);
    }

    private static void deliver(Listener listener, Snapshot snapshot) {
        try {
            listener.onChanged(snapshot);
        } catch (RuntimeException ignored) {
            // A dashboard observer must never break service lifecycle transitions.
        }
    }

    public static final class Snapshot {
        public final String eventId;
        public final String serviceInstanceId;
        public final long revision;
        public final long monotonicTimestampNanos;
        public final State state;
        public final String reason;

        private Snapshot(String eventId, String serviceInstanceId, long revision,
                         long monotonicTimestampNanos, State state, String reason) {
            this.eventId = eventId;
            this.serviceInstanceId = serviceInstanceId;
            this.revision = revision;
            this.monotonicTimestampNanos = monotonicTimestampNanos;
            this.state = state;
            this.reason = reason;
        }
    }
}
