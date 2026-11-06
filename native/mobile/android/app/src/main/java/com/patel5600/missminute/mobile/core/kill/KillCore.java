package com.patel5600.missminute.mobile.core.kill;

import com.patel5600.missminute.mobile.core.Clock;
import com.patel5600.missminute.mobile.core.audit.AuditLog;
import com.patel5600.missminute.mobile.core.audit.AuditRecord;
import com.patel5600.missminute.mobile.core.policy.Initiator;
import com.patel5600.missminute.mobile.core.policy.PermissionState;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * The kill switch. Order: write the killed state first, then stop everything, then audit.
 * One failing {@link Killable} never stops the others.
 */
public final class KillCore {
    private KillCore() {
    }

    public static KillState trigger(KillPath path, List<Killable> killables, KillStateStore store,
                                    AuditLog audit, Clock clock) {
        long now = clock.nowMs();
        List<String> labels = new ArrayList<>();
        for (Killable k : killables) {
            labels.add(k.label());
        }
        KillState state = new KillState(true, now, path, labels, true);
        boolean stateWritten = true;
        try {
            store.write(state);
        } catch (IOException | RuntimeException e) {
            stateWritten = false;
        }

        int failed = 0;
        for (Killable k : killables) {
            try {
                k.onKill();
            } catch (Exception e) {
                failed++;
            }
        }

        // The outcome comes first: the audit detail is capped at 80 characters, and a long list of labels
        // must be what gets cut, not the result. The full list is in the kill state file.
        StringBuilder detail = new StringBuilder("path=").append(path.wireName)
                .append(";failed=").append(failed).append(";saved=").append(stateWritten).append(";stopped=");
        for (int i = 0; i < labels.size(); i++) {
            detail.append(i == 0 ? "" : ",").append(labels.get(i));
        }
        try {
            audit.append(AuditRecord.Kind.KILL, null, null, Initiator.OWNER,
                    failed == 0 && stateWritten ? AuditRecord.Outcome.OK : AuditRecord.Outcome.FAILED,
                    detail.toString());
        } catch (RuntimeException e) {
            // The audit trail must not undo a kill.
        }
        return state;
    }

    /** After a kill she starts again in Observe with proactive reactions off. */
    public static PermissionState applyAfterKill(PermissionState state) {
        return state.withMode(com.patel5600.missminute.mobile.core.policy.Mode.OBSERVE).withProactive(false);
    }
}