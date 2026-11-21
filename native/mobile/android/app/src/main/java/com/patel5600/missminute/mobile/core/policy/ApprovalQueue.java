package com.patel5600.missminute.mobile.core.policy;

import com.patel5600.missminute.mobile.core.Clock;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/**
 * Actions waiting for the owner. The preview is built by native code from the validated arguments,
 * never taken from model text. Approvals expire after 10 minutes.
 */
public final class ApprovalQueue {
    public static final long EXPIRY_MS = 10L * 60L * 1000L;

    public static final class Approval {
        public final String id;
        public final String tool;
        public final String preview;
        public final long createdMs;
        public final long expiresMs;

        Approval(String id, String tool, String preview, long createdMs) {
            this.id = id;
            this.tool = tool;
            this.preview = preview;
            this.createdMs = createdMs;
            this.expiresMs = createdMs + EXPIRY_MS;
        }
    }

    public enum Result { APPROVED, DENIED, EXPIRED, UNKNOWN }

    private final Clock clock;
    private final SecureRandom random = new SecureRandom();
    private final List<Approval> pending = new ArrayList<>();

    public ApprovalQueue(Clock clock) {
        this.clock = clock;
    }

    private void prune() {
        long now = clock.nowMs();
        for (int i = pending.size() - 1; i >= 0; i--) {
            if (pending.get(i).expiresMs <= now) {
                pending.remove(i);
            }
        }
    }

    public synchronized Approval add(String tool, String preview) {
        prune();
        byte[] raw = new byte[8];
        random.nextBytes(raw);
        StringBuilder id = new StringBuilder("ap");
        for (byte b : raw) {
            id.append(String.format("%02x", b));
        }
        Approval a = new Approval(id.toString(), tool, preview, clock.nowMs());
        pending.add(a);
        return a;
    }

    /** The approvals still waiting, oldest first. */
    public synchronized List<Approval> list() {
        prune();
        return new ArrayList<>(pending);
    }

    /** Settles one approval. An expired or unknown id is never approved. */
    public synchronized Result decide(String id, boolean allow) {
        long now = clock.nowMs();
        for (int i = 0; i < pending.size(); i++) {
            Approval a = pending.get(i);
            if (a.id.equals(id)) {
                pending.remove(i);
                if (a.expiresMs <= now) {
                    return Result.EXPIRED;
                }
                return allow ? Result.APPROVED : Result.DENIED;
            }
        }
        return Result.UNKNOWN;
    }

    /** Denies everything waiting (used by the kill switch). Returns how many were dropped. */
    public synchronized int denyAll() {
        int n = pending.size();
        pending.clear();
        return n;
    }
}