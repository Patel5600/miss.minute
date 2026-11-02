package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;

import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.Handler;
import com.patel5600.missminute.mobile.core.audit.AuditRecord;
import com.patel5600.missminute.mobile.core.policy.Capability;
import com.patel5600.missminute.mobile.core.policy.Initiator;
import com.patel5600.missminute.mobile.core.policy.Mode;
import com.patel5600.missminute.mobile.core.policy.PermissionState;
import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.core.protocol.ProtocolException;

import java.io.IOException;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * permissions.get and permissions.setMode. Both are user-only message types: no model output reaches
 * them. Moving to a looser mode waits for a tap in a native dialog and also lifts the kill flag;
 * moving to a stricter mode never asks.
 */
public final class PermissionHandlers {
    private PermissionHandlers() {
    }

    public static void register(BridgeRouter router, final Context context, final UiBridge ui) {
        final MissMinutesApp app = MissMinutesApp.from(context);

        router.register("permissions.get", new Handler() {
            @Override
            public void handle(Message message, Reply reply) throws Exception {
                reply.ok(describe(app));
            }
        });

        router.register("permissions.setMode", new Handler() {
            @Override
            public void handle(Message message, final Reply reply) throws Exception {
                final Mode requested = parseMode(message.payload.opt("mode"));
                final PermissionState current = app.permissionStore().load();
                if (requested.ordinal() <= current.mode.ordinal()) {
                    save(app, current.withMode(requested), requested, false);
                    reply.ok(describe(app));
                    return;
                }
                final int body = requested == Mode.AUTHORIZED
                        ? R.string.dialog_mode_authorized_message : R.string.dialog_mode_suggest_message;
                ui.runOnUi(new Runnable() {
                    @Override
                    public void run() {
                        ui.confirm(R.string.dialog_mode_title, body, new UiBridge.Confirmed() {
                            @Override
                            public void onResult(boolean allowed) {
                                if (!allowed) {
                                    reply.fail("cancelled", "Not changed.");
                                    return;
                                }
                                try {
                                    save(app, app.permissionStore().load().withMode(requested), requested, true);
                                    reply.ok(describe(app));
                                } catch (IOException | JSONException | RuntimeException e) {
                                    reply.fail("internal", "Could not save the change.");
                                }
                            }
                        });
                    }
                });
            }
        });
    }

    private static Mode parseMode(Object raw) throws ProtocolException {
        if (raw instanceof String) {
            for (Mode mode : Mode.values()) {
                if (mode.name().equals(raw)) {
                    return mode;
                }
            }
        }
        throw new ProtocolException("bad_payload", "mode must be OBSERVE, SUGGEST or AUTHORIZED");
    }

    private static void save(MissMinutesApp app, PermissionState next, Mode mode, boolean liftKill) throws IOException {
        app.permissionStore().save(next);
        if (liftKill) {
            app.killSwitch().clearKillFlag();
        }
        app.auditLog().append(AuditRecord.Kind.PERMISSION, null, null, Initiator.OWNER, AuditRecord.Outcome.OK,
                "mode=" + mode.name());
    }

    /** What the page may know about the permission state. */
    public static JSONObject describe(MissMinutesApp app) throws JSONException {
        PermissionState state = app.permissionStore().load();
        JSONArray grants = new JSONArray();
        for (Capability capability : state.grants) {
            grants.put(capability.wireName);
        }
        return new JSONObject()
                .put("mode", state.mode.name())
                .put("proactive", state.proactive)
                .put("shareWithRemote", state.shareWithRemote)
                .put("grants", grants);
    }
}
