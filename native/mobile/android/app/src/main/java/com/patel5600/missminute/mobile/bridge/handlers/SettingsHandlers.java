package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;

import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.app.MissMinutesApp;
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
 * {@link SettingsRules} first. Switching on {@code proactive} or {@code share_system_with_remote}
 * gives her more freedom, so it waits for a tap in a native dialog; switching off never asks.
 * Those two live in the permission file, where a kill resets them.
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
                final boolean proactive = SettingsRules.PROACTIVE.equals(key);
                ui.runOnUi(new Runnable() {
                    @Override
                    public void run() {
                        ui.confirm(proactive ? R.string.dialog_proactive_title : R.string.dialog_share_title,
                                proactive ? R.string.dialog_proactive_message : R.string.dialog_share_message,
                                new UiBridge.Confirmed() {
                                    @Override
                                    public void onResult(boolean allowed) {
                                        if (!allowed) {
                                            reply.fail("cancelled", "Not changed.");
                                            return;
                                        }
                                        try {
                                            applyPermissionKey(app, key, (Boolean) value);
                                            reply.ok(new JSONObject().put("settings", all(app)));
                                        } catch (IOException | JSONException | RuntimeException e) {
                                            reply.fail("internal", "Could not save the change.");
                                        }
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
        PermissionState state = app.permissionStore().load();
        PermissionState next = SettingsRules.PROACTIVE.equals(key)
                ? state.withProactive(value) : state.withShareWithRemote(value);
        app.permissionStore().save(next);
        app.auditLog().append(AuditRecord.Kind.SETTINGS, null, null, Initiator.OWNER, AuditRecord.Outcome.OK,
                "set " + key + "=" + value);
    }

    /** Every setting a page may read, from both stores. */
    public static JSONObject all(MissMinutesApp app) throws JSONException {
        PermissionState state = app.permissionStore().load();
        return app.settings().toJson()
                .put(SettingsRules.PROACTIVE, state.proactive)
                .put(SettingsRules.SHARE_SYSTEM_WITH_REMOTE, state.shareWithRemote);
    }
}
