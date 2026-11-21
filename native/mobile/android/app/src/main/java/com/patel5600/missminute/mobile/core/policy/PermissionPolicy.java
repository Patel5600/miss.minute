package com.patel5600.missminute.mobile.core.policy;

/**
 * The single rule set for "may this run?". Pure: no state, no clock. Rules in order:
 * 1 unavailable on Android: DENY. 2 mic.capture: owner only. 3 OWNER: ALLOW (the tap is the consent).
 * 4 OBSERVE: DENY. 5 ALWAYS_ASK: ASK. 6 PROACTIVE: memory.propose ALLOW; a granted LOW capability in
 * AUTHORIZED with budget left ALLOW; else ASK. 7 MODEL: LOW ALLOW; MEDIUM ALLOW only in AUTHORIZED
 * with a grant and budget, else ASK.
 */
public final class PermissionPolicy {
    private PermissionPolicy() {
    }

    /**
     * @param granted         the owner granted this capability for automatic use
     * @param autoBudgetLeft  automatic actions left in the rolling hour
     */
    public static Decision decide(Mode mode, Capability cap, Initiator who, boolean granted, int autoBudgetLeft) {
        if (!cap.availableOnAndroid) {
            return Decision.deny("unavailable_on_android");
        }
        if (cap == Capability.MIC_CAPTURE) {
            return who == Initiator.OWNER ? Decision.allow() : Decision.deny("owner_only");
        }
        if (who == Initiator.OWNER) {
            return Decision.allow();
        }
        if (mode == Mode.OBSERVE) {
            return Decision.deny("observe_mode");
        }
        if (cap.risk == Risk.ALWAYS_ASK) {
            return Decision.ask("always_ask");
        }
        boolean automatic = mode == Mode.AUTHORIZED && granted && autoBudgetLeft > 0;
        if (who == Initiator.PROACTIVE) {
            if (cap == Capability.MEMORY_PROPOSE) {
                return Decision.allow();
            }
            if (cap.risk == Risk.LOW && automatic) {
                return Decision.allow();
            }
            return Decision.ask("proactive_needs_approval");
        }
        // MODEL
        if (cap.risk == Risk.LOW) {
            return Decision.allow();
        }
        if (cap.risk == Risk.MEDIUM && automatic) {
            return Decision.allow();
        }
        return Decision.ask("needs_approval");
    }
}