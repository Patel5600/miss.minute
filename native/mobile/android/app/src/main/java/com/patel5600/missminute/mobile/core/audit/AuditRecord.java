package com.patel5600.missminute.mobile.core.audit;

import com.patel5600.missminute.mobile.core.policy.Capability;
import com.patel5600.missminute.mobile.core.policy.Decision;
import com.patel5600.missminute.mobile.core.policy.Initiator;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One audit entry: metadata only. Every field is an enum, a number, a capability name, or a short
 * code-written detail (at most 80 characters, printable ASCII). Payload text is never recorded.
 */
public final class AuditRecord {
    public enum Kind { KILL, TOOL, PERMISSION, SETTINGS, CONSENT, REMINDER, PAIRING, VOICE, MEMORY }

    public enum Outcome { OK, DENIED, FAILED, CANCELLED, EXPIRED, NONE }

    public static final int MAX_DETAIL = 80;

    public final long seq;
    public final long timeMs;
    public final Kind kind;
    public final Capability capability;
    public final Decision.Outcome decision;
    public final Initiator initiator;
    public final Outcome outcome;
    public final String detail;

    public AuditRecord(long seq, long timeMs, Kind kind, Capability capability, Decision.Outcome decision,
                       Initiator initiator, Outcome outcome, String detail) {
        this.seq = seq;
        this.timeMs = timeMs;
        this.kind = kind;
        this.capability = capability;
        this.decision = decision;
        this.initiator = initiator;
        this.outcome = outcome;
        this.detail = sanitize(detail);
    }

    static String sanitize(String detail) {
        if (detail == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < detail.length() && sb.length() < MAX_DETAIL; i++) {
            char c = detail.charAt(i);
            sb.append(c >= 0x20 && c < 0x7f ? c : '?');
        }
        return sb.toString();
    }

    public String toJsonLine() {
        try {
            return new JSONObject()
                    .put("seq", seq)
                    .put("t", timeMs)
                    .put("kind", kind.name())
                    .put("cap", capability == null ? "" : capability.wireName)
                    .put("decision", decision == null ? "" : decision.name())
                    .put("initiator", initiator == null ? "" : initiator.name())
                    .put("outcome", outcome.name())
                    .put("detail", detail)
                    .toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}