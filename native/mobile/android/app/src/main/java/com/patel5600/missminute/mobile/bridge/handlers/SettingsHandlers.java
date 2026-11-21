package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;

import androidx.fragment.app.FragmentActivity;

import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.app.OwnerAuthenticator;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.Handler;
import com.patel5600.missminute.mobile.core.SettingsRules;
import com.patel5600.missminute.mobile.core.audit.AuditRecord;
import com.patel5600.missminute.mobile.core.policy.Initiator;
import com.patel5600.missminute.mobile.core.policy.PermissionState;
import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.core.protocol.ProtocolException;

import java.io.IOException;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * settings.get, settings.set and app.openMetadataWatcher. A value from the page is checked by
 * {@link SettingsRules} first. Enabling {@code proactive} or {@code share_system_with_remote}
 * loosens policy and therefore requires a strong biometric proof; disabling either one is an
 * immediate restriction. Those values are persisted with the other owner permission choices.
 */
public final class SettingsHandlers {
    private SettingsHandlers() {
    }

    public static void register(BridgeRouter router, final Context context, final UiBridge ui) {
        final MissMinutesApp app = MissMinutesApp.from(context);

        router.register("settings.get", new Handler() {
            @Override
            public void handle(Message message, Reply reply) throws Exception {
                reply.ok(new JSONObject().put("settings", all(app)));
            }
        });

        router.register("settings.set", new Handler() {
            @Override
            public void handle(Message message, final Reply reply) throws Exception {
                final String key = message.payload.optString("key", "");
                Object raw = message.payload.opt("value");
                final Object value;
                try {
                    value = SettingsRules.validate(key, raw, MissMinutesApp.CLOCK.nowMs());
                } catch (IllegalArgumentException e) {
                    throw new ProtocolException("bad_payload", e.getMessage());
                }
                if (!SettingsRules.isPermissionKey(key)) {
                    app.settings().apply(key, value);
                    reply.ok(new JSONObject().put("settings", all(app)));
                    return;
                }
                PermissionState current = app.permissionStore().load();
                Object currentValue = SettingsRules.PROACTIVE.equals(key) ? current.proactive : current.shareWithRemote;
                if (!SettingsRules.isLoosening(key, currentValue, value)) {
                    applyPermissionKey(app, key, (Boolean) value);
                    reply.ok(new JSONObject().put("settings", all(app)));
                    return;
                }
                if (!(context instanceof FragmentActivity)) {
                    reply.fail("unavailable", "Biometric owner authorization is unavailable in this screen.");
                    return;
                }
                final Object expectedValue = currentValue;
                final String target = key + ":" + value;
                ui.runOnUi(new Runnable() {
                    @Override
                    public void run() {
                        OwnerAuthenticator.authenticate((FragmentActivity) context, "settings.set", target,
                                new OwnerAuthenticator.Callback() {
                            @Override
                            public void onAuthenticated(String proofId) {
                                try {
                                    PermissionState latest = app.permissionStore().load();
                                    Object latestValue = SettingsRules.PROACTIVE.equals(key)
                                            ? latest.proactive : latest.shareWithRemote;
                                    if (!expectedValue.equals(latestValue)) {
                                        reply.fail("cancelled", "The permission setting changed during authentication. Retry the operation.");
                                        return;
                                    }
                                    applyPermissionKey(app, key, (Boolean) value, "keystore-ecdsa:" + proofId);
                                    reply.ok(new JSONObject().put("settings", all(app)));
                                } catch (IOException | JSONException | RuntimeException e) {
                                    reply.fail("internal", "Authentication succeeded, but the setting could not be saved.");
                                }
                            }

                            @Override
                            public void onFailure(String reason) {
                                boolean canceled = reason != null
                                        && reason.toLowerCase(java.util.Locale.ROOT).contains("canceled");
                                reply.fail(canceled ? "cancelled" : "forbidden",
                                        reason == null ? "Owner authentication failed." : reason);
                            }
                        });
                    }
                });
            }
        });

        router.register("app.openMetadataWatcher", new Handler() {
            @Override
            public void handle(Message message, final Reply reply) {
                ui.runOnUi(new Runnable() {
                    @Override
                    public void run() {
                        ui.openMetadataWatcher();
                        reply.ok(new JSONObject());
                    }
                });
            }
        });
    }

    private static void applyPermissionKey(MissMinutesApp app, String key, boolean value) throws IOException {
        applyPermissionKey(app, key, value, "explicit-restriction");
    }

    private static void applyPermissionKey(MissMinutesApp app, String key, boolean value, String authorization)
            throws IOException {
        PermissionState state = app.permissionStore().load();
        PermissionState next = SettingsRules.PROACTIVE.equals(key)
                ? state.withProactive(value) : state.withShareWithRemote(value);
        app.permissionStore().save(next);
        app.auditLog().append(AuditRecord.Kind.SETTINGS, null, null, Initiator.OWNER, AuditRecord.Outcome.OK,
                "set " + key + "=" + value + " authorization=" + authorization);
    }

    /** Every setting a page may read, from both stores. */
    public static JSONObject all(MissMinutesApp app) throws JSONException {
        PermissionState state = app.permissionStore().load();
        return app.settings().toJson()
                .put(SettingsRules.PROACTIVE, state.proactive)
                .put(SettingsRules.SHARE_SYSTEM_WITH_REMOTE, state.shareWithRemote);
    }
}
