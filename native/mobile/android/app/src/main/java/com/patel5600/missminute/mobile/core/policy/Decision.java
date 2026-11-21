package com.patel5600.missminute.mobile.core.policy;

/** The verdict of {@link PermissionPolicy#decide}. Immutable. */
public final class Decision {
    public enum Outcome { ALLOW, ASK, DENY }

    public final Outcome outcome;
    /** Short machine-readable reason, for example "observe_mode". Empty for ALLOW. */
    public final String reason;

    private Decision(Outcome outcome, String reason) {
        this.outcome = outcome;
        this.reason = reason;
    }

    public static Decision allow() {
        return new Decision(Outcome.ALLOW, "");
    }

    public static Decision ask(String reason) {
        return new Decision(Outcome.ASK, reason);
    }

    public static Decision deny(String reason) {
        return new Decision(Outcome.DENY, reason);
    }

    public boolean isAllow() {
        return outcome == Outcome.ALLOW;
    }

    @Override
    public String toString() {
        return outcome + (reason.isEmpty() ? "" : ":" + reason);
    }
}