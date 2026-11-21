package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;

import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.app.OwnerAuthority;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.Handler;
import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.core.protocol.Role;

import org.json.JSONArray;
import org.json.JSONObject;

/** SQLCipher owner-data access; the Rust session policy is checked at every read and write. */
public final class OwnerDataHandlers {
    private OwnerDataHandlers() {}

    interface CapabilityAuthorizer { boolean authorize(String capability); }

    public static void register(BridgeRouter router, Context context) {
        register(router, context, OwnerAuthority::authorizeOwnerCapability);
    }

    /**
     * Binds the one-time migration renderer to the owner session that started migration. A later
     * unlock must not adopt an in-flight import started under a previous session.
     */
    public static void registerMigration(BridgeRouter router, Context context, String sessionId) {
        if (router.role() != Role.MIGRATION || sessionId == null || sessionId.isEmpty()) {
            throw new IllegalArgumentException("migration requires a captured owner session");
        }
        register(router, context, bindSession(sessionId, OwnerAuthority::authorizeOwnerCapability));
    }

    static CapabilityAuthorizer bindSession(String sessionId, SessionCapabilityCheck check) {
        if (sessionId == null || sessionId.isEmpty() || check == null) {
            throw new IllegalArgumentException("a captured owner session and capability check are required");
        }
        return capability -> check.authorize(sessionId, capability);
    }

    interface SessionCapabilityCheck { boolean authorize(String sessionId, String capability); }

    static void register(BridgeRouter router, Context context, CapabilityAuthorizer authorizer) {
        router.register("owner.store", (Message message, Handler.Reply reply) -> {
            String operation = message.payload.optString("op", "");
            String store = message.payload.optString("store", "");
            boolean migrationOperation = isMigrationOperation(operation);
            if (migrationOperation != (router.role() == Role.MIGRATION)) {
                reply.fail("forbidden", "This WebView is not allowed to use that owner-data operation.");
                return;
            }
            String key = message.payload.optString("key", "");
            JSONObject record = message.payload.optJSONObject("record");
            boolean providerSecret = "kv".equals(store) && (key.startsWith("vault:web:secret:")
                    || (record != null && record.optString("key", "").startsWith("vault:web:secret:"))
                    || hasProviderSecret(message.payload.optJSONArray("records")));
            if (providerSecret && !allowProviderSecretMigration(router.role(), operation, store)) {
                reply.fail("forbidden", "Provider credentials are available only to the native provider service.");
                return;
            }
            String capability = isRead(operation) ? "memory.private.read" : "memory.private.write";
            if (!authorizer.authorize(capability)) {
                reply.fail("owner_auth_required", "Unlock Miss Minutes with the device biometric to access private owner data.");
                return;
            }
            try {
                MissMinutesApp app = MissMinutesApp.from(context);
                if (!migrationOperation) {
                    JSONArray migrationStatus = app.ownerDataDb().execute(new JSONObject().put("op", "migrationStatus"));
                    boolean ready = migrationStatus.length() > 0 && migrationStatus.optJSONObject(0) != null
                            && migrationStatus.optJSONObject(0).optBoolean("done", false);
                    if (!ready) {
                        reply.fail("unavailable", "Owner data is unavailable until the isolated encrypted migration finishes.");
                        return;
                    }
                }
                JSONArray data = app.ownerDataDb().execute(message.payload);
                reply.ok(new JSONObject().put("data", data));
            } catch (Exception error) {
                if (com.patel5600.missminute.mobile.BuildConfig.DEBUG) {
                    android.util.Log.e("MMOwnerStore", "Encrypted owner store operation failed.", error);
                }
                String detail = error.getMessage();
                reply.fail("unavailable", detail == null || detail.isEmpty()
                        ? "The encrypted owner data store is unavailable." : detail);
            }
        });
    }

    private static boolean hasProviderSecret(JSONArray records) {
        if (records == null) return false;
        for (int i = 0; i < records.length(); i++) {
            JSONObject record = records.optJSONObject(i);
            if (record != null && record.optString("key", "").startsWith("vault:web:secret:")) return true;
        }
        return false;
    }

    static boolean allowProviderSecretMigration(Role role, String operation, String store) {
        return role == Role.MIGRATION && "importBatch".equals(operation) && "kv".equals(store);
    }

    private static boolean isRead(String operation) {
        return "migrationStatus".equals(operation) || "list".equals(operation) || "get".equals(operation)
                || "messagesForChat".equals(operation) || "scheduleBetween".equals(operation);
    }

    private static boolean isMigrationOperation(String operation) {
        return "migrationStatus".equals(operation) || "importBatch".equals(operation)
                || "migrationComplete".equals(operation);
    }
}
