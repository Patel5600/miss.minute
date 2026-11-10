package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;

import androidx.fragment.app.FragmentActivity;

import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.app.OwnerAuthenticator;
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
import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * permissions.get and permissions.setMode. Stricter modes can be selected directly.
 * Raising the permission mode requires an operation-bound strong biometric followed by
 * a Keystore ECDSA signature. Persistence and the reply happen only after proof verification.
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
                final PermissionState beforePrompt = app.permissionStore().load();

                if (requested == beforePrompt.mode) {
                    reply.ok(describe(app));
                    return;
                }

                // Tightening policy never requires a biometric and never revives a killed service.
                if (requested.ordinal() < beforePrompt.mode.ordinal()) {
                    save(app, beforePrompt.withMode(requested), requested, "explicit-stricter-mode");
                    reply.ok(describe(app));
                    return;
                }

                if (!(context instanceof FragmentActivity)) {
                    reply.fail("unavailable", "Biometric owner authorization is unavailable in this screen.");
                    return;
                }

                ui.runOnUi(new Runnable() {
                    @Override
                    public void run() {
                        OwnerAuthenticator.authenticate((FragmentActivity) context,
                                "permissions.setMode", requested.name(), new OwnerAuthenticator.Callback() {
                            @Override
                            public void onAuthenticated(String proofId) {
                                try {
                                    PermissionState latest = app.permissionStore().load();
                                    if (!sameState(beforePrompt, latest)) {
                                        reply.fail("cancelled", "Permission settings changed during authentication. Retry the operation.");
                                        return;
                                    }
                                    save(app, latest.withMode(requested), requested, "keystore-ecdsa:" + proofId);
                                    // The bridge reply is sent only after the durable policy write and
                                    // audit record attempt. The UI then refreshes from the native store.
                                    reply.ok(describe(app));
                                } catch (IOException | JSONException | RuntimeException error) {
                                    reply.fail("internal", "Authentication succeeded, but the permission change could not be saved.");
                                }
                            }

                            @Override
                            public void onFailure(String reason) {
                                boolean canceled = reason != null
                                        && reason.toLowerCase(Locale.ROOT).contains("canceled");
                                reply.fail(canceled ? "cancelled" : "forbidden",
                                        reason == null ? "Owner authentication failed." : reason);
                            }
                        });
                    }
                });
            }
        });
    }

    private static boolean sameState(PermissionState left, PermissionState right) {
        return left.mode == right.mode
                && left.proactive == right.proactive
                && left.shareWithRemote == right.shareWithRemote
                && left.grants.equals(right.grants);
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

    private static void save(MissMinutesApp app, PermissionState next, Mode mode, String proof) throws IOException {
        app.permissionStore().save(next);
        app.auditLog().append(AuditRecord.Kind.PERMISSION, null, null, Initiator.OWNER,
                AuditRecord.Outcome.OK, "mode=" + mode.name() + " authorization=" + proof);
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
