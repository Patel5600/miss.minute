package com.patel5600.missminute.mobile.bridge.handlers;

import android.app.Activity;
import android.content.Context;

import com.patel5600.missminute.mobile.app.OwnerAuthority;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.Handler;
import com.patel5600.missminute.mobile.core.protocol.Message;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Explicit, user-initiated owner verification for controls inside the bundled dashboard. */
public final class OwnerHandlers {
    private static final ExecutorService RECOVERY_EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "mm-device-recovery");
        thread.setDaemon(true);
        return thread;
    });

    private OwnerHandlers() {}

    public static void register(BridgeRouter router, Context context, UiBridge ui) {
        router.register("owner.identity.summary", (Message message, Handler.Reply reply) -> {
            try { reply.ok(OwnerAuthority.identitySummary(context)); }
            catch (Exception error) { reply.fail("owner_auth_required", safeMessage(error)); }
        });
        router.register("owner.device.revoke", (Message message, Handler.Reply reply) -> {
            if (!(context instanceof Activity)) {
                reply.fail("unavailable", "Device revocation needs the Miss Minutes dashboard open.");
                return;
            }
            String deviceId = message.payload.optString("deviceId", "");
            if (deviceId.isEmpty()) { reply.fail("bad_payload", "Choose a trusted device to revoke."); return; }
            if (!OwnerAuthority.hasOwnerSession()) {
                reply.fail("owner_auth_required", "Unlock owner access before revoking a device.");
                return;
            }
            ui.runOnUi(() -> OwnerAuthority.revokeTrustedDevice((Activity) context, deviceId, (sessionId, error) -> {
                if (error != null) { reply.fail("unavailable", error); return; }
                try { reply.ok(new JSONObject().put("status", "revoked")); }
                catch (org.json.JSONException encodeError) { reply.fail("internal", "The revocation completed, but its status could not be returned."); }
            }));
        });
        router.register("owner.pairing.request.create", (Message message, Handler.Reply reply) -> {
            try {
                reply.ok(new JSONObject().put("request", OwnerAuthority.createPairingRequest(context)));
            } catch (Exception error) {
                reply.fail("unavailable", safeMessage(error));
            }
        });
        router.register("owner.pairing.request.approve", (Message message, Handler.Reply reply) -> {
            if (!OwnerAuthority.hasOwnerSession()) {
                reply.fail("owner_auth_required", "Unlock owner access before approving a new device.");
                return;
            }
            String request = message.payload.optString("request", "");
            if (request.isEmpty()) { reply.fail("bad_payload", "Paste the pairing request from the new device."); return; }
            ui.runOnUi(() -> OwnerAuthority.approvePairingRequest((Activity) context, request, (receipt, error) -> {
                if (error != null) { reply.fail("unavailable", error); return; }
                try { reply.ok(new JSONObject().put("receipt", receipt)); }
                catch (org.json.JSONException encodeError) { reply.fail("internal", "The signed pairing receipt could not be displayed."); }
            }));
        });
        router.register("owner.pairing.receipt.import", (Message message, Handler.Reply reply) -> {
            try {
                String status = OwnerAuthority.acceptPairingReceipt(context, message.payload.optString("receipt", ""));
                reply.ok(new JSONObject().put("status", status));
            } catch (IllegalArgumentException | org.json.JSONException error) {
                reply.fail("bad_payload", safeMessage(error));
            } catch (SecurityException error) {
                reply.fail("forbidden", safeMessage(error));
            } catch (Exception error) {
                reply.fail("unavailable", safeMessage(error));
            }
        });
        router.register("owner.recovery.create", (Message message, Handler.Reply reply) -> {
            if (!(context instanceof Activity)) {
                reply.fail("unavailable", "Recovery setup needs the Miss Minutes dashboard open.");
                return;
            }
            String phrase = message.payload.optString("passphrase", "");
            if (phrase.length() < 12 || phrase.length() > 256) {
                reply.fail("bad_payload", "Use a recovery passphrase between 12 and 256 characters.");
                return;
            }
            char[] passphrase = phrase.toCharArray();
            ui.runOnUi(() -> OwnerAuthority.createRecoveryMaterial((Activity) context, passphrase, (material, error) -> {
                if (error != null) { reply.fail("owner_auth_required", error); return; }
                try { reply.ok(new JSONObject().put("material", material)); }
                catch (org.json.JSONException encodeError) { reply.fail("internal", "The encrypted recovery kit could not be returned."); }
            }));
        });
        router.register("owner.recovery.restore", (Message message, Handler.Reply reply) -> {
            String material = message.payload.optString("material", "");
            String phrase = message.payload.optString("passphrase", "");
            if (material.isEmpty() || material.length() > 32 * 1024 || phrase.length() < 12 || phrase.length() > 256) {
                reply.fail("bad_payload", "Recovery kit or passphrase is missing or invalid.");
                return;
            }
            char[] passphrase = phrase.toCharArray();
            RECOVERY_EXECUTOR.execute(() -> {
                try {
                    String result = OwnerAuthority.recoverDevice(context, material, passphrase);
                    if (!"recovered".equals(result)) throw new SecurityException("Recovery did not complete.");
                    ui.runOnUi(ui::refreshOwnerControls);
                    reply.ok(new JSONObject().put("status", result));
                } catch (Exception error) {
                    reply.fail("unavailable", safeMessage(error));
                } finally {
                    java.util.Arrays.fill(passphrase, '\0');
                }
            });
        });
        router.register("owner.authenticate", (Message message, Handler.Reply reply) -> {
            if (!OwnerAuthority.isEnrolled(context)) {
                reply.fail("owner_auth_required", "Choose Owner setup in the app header before using owner controls.");
                return;
            }
            if (OwnerAuthority.hasOwnerSession()) {
                reply.ok(new JSONObject().put("authenticated", true));
                ui.refreshOwnerControls();
                return;
            }
            ui.runOnUi(() -> OwnerAuthority.authenticate((Activity) context, (sessionId, error) -> {
                if (error != null) {
                    reply.fail("owner_auth_required", error);
                    return;
                }
                try {
                    boolean authenticated = OwnerAuthority.hasOwnerSession();
                    reply.ok(new JSONObject().put("authenticated", authenticated));
                    ui.refreshOwnerControls();
                } catch (org.json.JSONException e) {
                    reply.fail("internal", "The owner session was created, but the dashboard could not refresh its status.");
                }
            }));
        });
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }
}
