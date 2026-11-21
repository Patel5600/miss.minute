package com.patel5600.missminute.mobile.bridge.handlers;

import android.app.Activity;
import android.content.Context;

import com.patel5600.missminute.mobile.app.ChatGptOAuth;
import com.patel5600.missminute.mobile.app.OwnerAuthority;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.Handler;

import org.json.JSONObject;

/** Owner-only Android ChatGPT account, model and response-proxy operations. */
public final class ChatGptHandlers {
    private ChatGptHandlers() {}

    public static void register(BridgeRouter router, Context context) {
        register(router, context, null);
    }

    public static void register(BridgeRouter router, Context context, UiBridge ui) {
        router.register("provider.chatgpt.account", (message, reply) -> {
            String sessionId = authorizedSession(reply, "ai.provider.use");
            if (sessionId == null) return;
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                reply.fail("owner_auth_required", "Owner access expired before the account status was read.");
                return;
            }
            reply.ok(ChatGptOAuth.account(context));
        });

        router.register("provider.chatgpt.signIn", (message, reply) -> {
            String sessionId = authorizedSession(reply, "settings.modify");
            if (sessionId == null) return;
            if (!(context instanceof Activity)) {
                reply.fail("unavailable", "ChatGPT sign-in needs the Miss Minutes dashboard open.");
                return;
            }
            ChatGptOAuth.signIn((Activity) context, result(reply, sessionId, "settings.modify"));
        });

        router.register("provider.chatgpt.signOut", (message, reply) -> {
            String sessionId = authorizedSession(reply, "settings.modify");
            if (sessionId == null) return;
            ChatGptOAuth.signOut(context, result(reply, sessionId, "settings.modify"));
        });

        router.register("provider.chatgpt.models", (message, reply) -> {
            String sessionId = authorizedSession(reply, "ai.provider.use");
            if (sessionId == null) return;
            ChatGptOAuth.models(context, result(reply, sessionId, "ai.provider.use"));
        });

        router.register("provider.chatgpt.request", (message, reply) -> {
            String sessionId = authorizedSession(reply, "ai.provider.use");
            if (sessionId == null) return;
            String url = message.payload.optString("url", "");
            String method = message.payload.optString("method", "");
            String body = message.payload.optString("body", "");
            if (message.payload.optBoolean("stream", false)) {
                if (ui == null) {
                    reply.fail("unavailable", "Streaming requires the dashboard UI bridge.");
                    return;
                }
                String requestId = message.payload.optString("requestId", message.id);
                ChatGptOAuth.streamRequest(context, requestId, url, method, body,
                        payload -> ui.push("provider.event", payload),
                        result(reply, sessionId, "ai.provider.use"));
            } else {
                ChatGptOAuth.request(context, message.id, url, method, body, result(reply, sessionId, "ai.provider.use"));
            }
        });

        router.register("provider.chatgpt.cancel", (message, reply) -> {
            String requestId = message.payload.optString("requestId", "");
            if (requestId.isEmpty() || requestId.length() > 64) {
                reply.fail("bad_payload", "The ChatGPT request identifier is invalid.");
                return;
            }
            ChatGptOAuth.cancel(requestId);
            reply.ok(new JSONObject().put("cancelled", true));
        });
    }

    private static String authorizedSession(Handler.Reply reply, String capability) {
        String sessionId = OwnerAuthority.ownerSessionForCapability(capability);
        if (sessionId != null) return sessionId;
        reply.fail("owner_auth_required", "Unlock Miss Minutes with the device biometric to use ChatGPT.");
        return null;
    }

    private static ChatGptOAuth.Callback result(Handler.Reply reply, String sessionId, String capability) {
        return (JSONObject value, String error) -> {
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, capability)) {
                reply.fail("owner_auth_required", "Owner access expired before the ChatGPT request completed.");
                return;
            }
            if (error != null) reply.fail("unavailable", error);
            else reply.ok(value == null ? new JSONObject() : value);
        };
    }
}
