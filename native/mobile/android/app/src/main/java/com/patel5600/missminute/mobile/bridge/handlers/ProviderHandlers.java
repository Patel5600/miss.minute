package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;

import com.patel5600.missminute.mobile.OwnerDataDb;
import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.app.OwnerAuthority;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** Android provider boundary. Credentials are read and injected only in native code. */
public final class ProviderHandlers {
    private static final int MAX_BODY = 5 * 1024 * 1024;
    private static final int MAX_TEXT_RESPONSE = 2 * 1024 * 1024;
    private static final int MAX_STREAM_CHARS = 4 * 1024 * 1024;
    private static final ExecutorService IO = Executors.newCachedThreadPool();
    private static final ConcurrentHashMap<String, String> SESSION_SECRETS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, HttpURLConnection> ACTIVE_REQUESTS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, StreamHandle> ACTIVE_STREAMS = new ConcurrentHashMap<>();
    private static final Set<String> PROVIDERS = new HashSet<>(Arrays.asList("openai", "gemini", "anthropic", "openrouter", "ollama", "elevenlabs"));
    private ProviderHandlers() {}

    private static final class StreamHandle {
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        volatile HttpURLConnection connection;
    }

    public static void register(BridgeRouter router, Context context) {
        register(router, context, null);
    }

    public static void register(BridgeRouter router, Context context, UiBridge ui) {
        router.register("provider.secret.status", (message, reply) -> {
            if (!authorized(reply)) return;
            String provider = provider(message.payload.optString("provider", ""));
            try { reply.ok(new JSONObject().put("present", SESSION_SECRETS.containsKey(provider) || db(context).hasProviderCredential(provider))
                    .put("remembered", db(context).hasProviderCredential(provider))); }
            catch (Exception e) { reply.fail("unavailable", "Provider credential storage is unavailable."); }
        });
        router.register("provider.secret.set", (message, reply) -> {
            if (!authorized(reply)) return;
            String provider = provider(message.payload.optString("provider", ""));
            try {
                String value = message.payload.optString("value", "");
                if (message.payload.optBoolean("remember", true)) {
                    db(context).setProviderCredential(provider, value);
                    SESSION_SECRETS.remove(provider);
                } else {
                    validateSecret(value);
                    db(context).removeProviderCredential(provider);
                    SESSION_SECRETS.put(provider, value.trim());
                }
                reply.ok(new JSONObject().put("present", true));
            } catch (Exception e) { reply.fail("bad_payload", safeMessage(e)); }
        });
        router.register("provider.secret.remember", (message, reply) -> {
            if (!authorized(reply)) return;
            String provider = provider(message.payload.optString("provider", ""));
            boolean remember = message.payload.optBoolean("remember", false);
            try {
                String value = SESSION_SECRETS.get(provider);
                if (remember) {
                    if (value == null) value = db(context).getProviderCredential(provider);
                    if (value.isEmpty()) throw new IllegalStateException("No provider credential is saved.");
                    db(context).setProviderCredential(provider, value);
                    SESSION_SECRETS.remove(provider);
                } else {
                    value = db(context).getProviderCredential(provider);
                    if (value.isEmpty()) throw new IllegalStateException("No provider credential is saved.");
                    db(context).removeProviderCredential(provider);
                    SESSION_SECRETS.put(provider, value);
                }
                reply.ok(new JSONObject().put("present", true).put("remembered", remember));
            } catch (Exception e) { reply.fail("unavailable", safeMessage(e)); }
        });
        router.register("provider.secret.remove", (message, reply) -> {
            if (!authorized(reply)) return;
            String provider = provider(message.payload.optString("provider", ""));
            try { db(context).removeProviderCredential(provider); SESSION_SECRETS.remove(provider); reply.ok(new JSONObject().put("present", false)); }
            catch (Exception e) { reply.fail("unavailable", "Provider credential storage is unavailable."); }
        });
        router.register("provider.http.request", (message, reply) -> {
            if (!authorized(reply, "ai.provider.use")) return;
            String sessionId = OwnerAuthority.ownerSessionForCapability("ai.provider.use");
            if (sessionId == null) { reply.fail("owner_auth_required", "Unlock owner access before sending a provider request."); return; }
            IO.execute(() -> perform(context, message.id, message.payload, sessionId, reply));
        });
        router.register("provider.http.stream", (message, reply) -> {
            if (ui == null) {
                reply.fail("unavailable", "Streaming requires the dashboard UI bridge.");
                return;
            }
            if (!authorized(reply, "ai.provider.use")) return;
            String sessionId = OwnerAuthority.ownerSessionForCapability("ai.provider.use");
            if (sessionId == null) { reply.fail("owner_auth_required", "Unlock owner access before streaming from a provider."); return; }
            String requestId;
            try {
                requestId = validateStreamRequestId(message.payload.optString("requestId", message.id));
                String provider = provider(message.payload.optString("provider", ""));
                URL url = new URL(message.payload.optString("url", ""));
                validateTarget(provider, url);
                String method = message.payload.optString("method", "POST");
                if (!"GET".equals(method) && !"POST".equals(method)) {
                    throw new IllegalArgumentException("Unsupported provider request method.");
                }
                String body = message.payload.optString("body", "");
                if (body.getBytes(StandardCharsets.UTF_8).length > MAX_BODY) {
                    throw new IllegalArgumentException("Provider request body is too large.");
                }
            } catch (Exception e) {
                reply.fail("bad_payload", safeMessage(e));
                return;
            }
            StreamHandle handle = new StreamHandle();
            if (ACTIVE_STREAMS.putIfAbsent(requestId, handle) != null) {
                reply.fail("bad_payload", "A provider stream with this request identifier is already running.");
                return;
            }
            try {
                reply.ok(new JSONObject().put("requestId", requestId).put("streaming", true));
            } catch (Exception e) {
                ACTIVE_STREAMS.remove(requestId, handle);
                reply.fail("internal", "Could not acknowledge provider stream start.");
                return;
            }
            IO.execute(() -> performStream(context, ui, requestId, message.payload, sessionId, handle));
        });
        router.register("provider.http.cancel", (message, reply) -> {
            String requestId = message.payload.optString("requestId", "");
            if (requestId.isEmpty() || requestId.length() > 64) {
                reply.fail("bad_payload", "The provider request identifier is invalid.");
                return;
            }
            boolean cancelled = false;
            HttpURLConnection connection = ACTIVE_REQUESTS.get(requestId);
            if (connection != null) {
                connection.disconnect();
                cancelled = true;
            }
            StreamHandle stream = ACTIVE_STREAMS.get(requestId);
            if (stream != null) {
                stream.cancelled.set(true);
                HttpURLConnection streamConn = stream.connection;
                if (streamConn != null) streamConn.disconnect();
                cancelled = true;
            }
            reply.ok(new JSONObject().put("cancelled", cancelled));
        });
        router.register("provider.openrouter.exchange", (message, reply) -> {
            if (!authorized(reply)) return;
            String sessionId = OwnerAuthority.ownerSessionForCapability("settings.modify");
            if (sessionId == null) { reply.fail("owner_auth_required", "Unlock owner access before pairing OpenRouter."); return; }
            IO.execute(() -> exchangeOpenRouter(context, message.payload, sessionId, reply));
        });
    }

    private static OwnerDataDb db(Context context) throws Exception { return MissMinutesApp.from(context).ownerDataDb(); }
    private static boolean authorized(com.patel5600.missminute.mobile.bridge.Handler.Reply reply) {
        return authorized(reply, "settings.modify");
    }

    private static boolean authorized(com.patel5600.missminute.mobile.bridge.Handler.Reply reply, String capability) {
        if (OwnerAuthority.authorizeOwnerCapability(capability)) return true;
        reply.fail("owner_auth_required", "Unlock Miss Minutes with the device biometric before using provider credentials.");
        return false;
    }

    static String validateStreamRequestId(String requestId) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.-]{1,64}")) {
            throw new IllegalArgumentException("The provider stream identifier is invalid.");
        }
        return requestId;
    }

    private static String provider(String value) {
        String normalized = value.toLowerCase(Locale.ROOT);
        if (!PROVIDERS.contains(normalized)) throw new IllegalArgumentException("Unsupported provider.");
        return normalized;
    }

    private static void perform(Context context, String requestId, JSONObject request, String sessionId, com.patel5600.missminute.mobile.bridge.Handler.Reply reply) {
        HttpURLConnection connection = null;
        try {
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) throw new SecurityException("Owner session expired before the provider request.");
            String provider = provider(request.optString("provider", ""));
            URL url = new URL(request.optString("url", ""));
            validateTarget(provider, url);
            String method = request.optString("method", "GET");
            if (!"GET".equals(method) && !"POST".equals(method)) throw new IllegalArgumentException("Unsupported provider request method.");
            connection = (HttpURLConnection) url.openConnection();
            ACTIVE_REQUESTS.put(requestId, connection);
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) throw new SecurityException("Owner session expired before the provider request.");
            connection.setRequestMethod(method);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(120_000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            JSONObject headers = request.optJSONObject("headers");
            if (headers != null) {
                for (java.util.Iterator<String> it = headers.keys(); it.hasNext();) {
                    String name = it.next();
                    String lower = name.toLowerCase(Locale.ROOT);
                    if ("authorization".equals(lower) || "proxy-authorization".equals(lower) || "x-api-key".equals(lower)
                            || "x-goog-api-key".equals(lower) || "xi-api-key".equals(lower) || "host".equals(lower)
                            || "cookie".equals(lower) || "content-length".equals(lower)) continue;
                    String value = headers.optString(name, "");
                    if (value.length() <= 2048 && !containsControl(value)) connection.setRequestProperty(name, value);
                }
            }
            String key = SESSION_SECRETS.get(provider);
            if (key == null) key = db(context).getProviderCredential(provider);
            injectCredential(connection, provider, key);
            String body = request.optString("body", "");
            if (!body.isEmpty()) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_BODY) throw new IllegalArgumentException("Provider request body is too large.");
                connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] bytes = input == null ? new byte[0]
                    : readBounded(input, request.optBoolean("binary", false) ? MAX_BODY : MAX_TEXT_RESPONSE);
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use"))
                throw new SecurityException("Owner session ended while the provider request was running; its response was discarded.");
            JSONObject outHeaders = new JSONObject();
            for (String name : Arrays.asList("content-type", "x-request-id", "retry-after")) {
                String value = connection.getHeaderField(name);
                if (value != null) outHeaders.put(name, value);
            }
            JSONObject response = new JSONObject().put("status", status).put("headers", outHeaders);
            if (request.optBoolean("binary", false)) response.put("bodyBase64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
            else response.put("body", new String(bytes, StandardCharsets.UTF_8));
            reply.ok(response);
        } catch (Exception e) {
            reply.fail("unavailable", safeMessage(e));
        } finally { ACTIVE_REQUESTS.remove(requestId); if (connection != null) connection.disconnect(); }
    }

    private static void performStream(
            Context context,
            UiBridge ui,
            String requestId,
            JSONObject request,
            String sessionId,
            StreamHandle handle) {
        HttpURLConnection connection = null;
        try {
            if (handle.cancelled.get() || !OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                pushStreamError(ui, requestId, "owner_auth_required", "Owner session ended before the provider stream began.");
                return;
            }
            String provider = provider(request.optString("provider", ""));
            URL url = new URL(request.optString("url", ""));
            validateTarget(provider, url);
            String method = request.optString("method", "POST");
            if (!"GET".equals(method) && !"POST".equals(method)) {
                throw new IllegalArgumentException("Unsupported provider request method.");
            }
            connection = (HttpURLConnection) url.openConnection();
            handle.connection = connection;
            if (handle.cancelled.get() || !OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                pushStreamError(ui, requestId, "owner_auth_required", "Owner session ended before connecting.");
                return;
            }
            connection.setRequestMethod(method);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(120_000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            JSONObject headers = request.optJSONObject("headers");
            if (headers != null) {
                for (java.util.Iterator<String> it = headers.keys(); it.hasNext();) {
                    String name = it.next();
                    String lower = name.toLowerCase(Locale.ROOT);
                    if ("authorization".equals(lower) || "proxy-authorization".equals(lower) || "x-api-key".equals(lower)
                            || "x-goog-api-key".equals(lower) || "xi-api-key".equals(lower) || "host".equals(lower)
                            || "cookie".equals(lower) || "content-length".equals(lower)) continue;
                    String value = headers.optString(name, "");
                    if (value.length() <= 2048 && !containsControl(value)) connection.setRequestProperty(name, value);
                }
            }
            String key = SESSION_SECRETS.get(provider);
            if (key == null) key = db(context).getProviderCredential(provider);
            injectCredential(connection, provider, key);
            String body = request.optString("body", "");
            if (!body.isEmpty()) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_BODY) throw new IllegalArgumentException("Provider request body is too large.");
                connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (handle.cancelled.get() || !OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                pushStreamError(ui, requestId, "owner_auth_required", "Owner session ended; stream discarded.");
                return;
            }
            JSONObject outHeaders = new JSONObject();
            for (String name : Arrays.asList("content-type", "x-request-id", "retry-after")) {
                String value = connection.getHeaderField(name);
                if (value != null) outHeaders.put(name, value);
            }
            ui.push("provider.event", new JSONObject()
                    .put("requestId", requestId)
                    .put("event", "start")
                    .put("status", status)
                    .put("headers", outHeaders));

            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (input != null) {
                char[] buf = new char[4096];
                int totalChars = 0;
                try (Reader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
                    int n;
                    while ((n = reader.read(buf)) != -1) {
                        if (handle.cancelled.get()) break;
                        if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                            pushStreamError(ui, requestId, "owner_auth_required", "Owner session ended while streaming; partial output halted.");
                            return;
                        }
                        totalChars += n;
                        if (totalChars > MAX_STREAM_CHARS) {
                            throw new IllegalArgumentException("Provider stream exceeded the maximum response size.");
                        }
                        ui.push("provider.event", new JSONObject()
                                .put("requestId", requestId)
                                .put("event", "chunk")
                                .put("data", new String(buf, 0, n)));
                    }
                }
            }
            if (!handle.cancelled.get() && !OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                pushStreamError(ui, requestId, "owner_auth_required", "Owner session ended at stream completion.");
                return;
            }
            ui.push("provider.event", new JSONObject()
                    .put("requestId", requestId)
                    .put("event", "done")
                    .put("status", status)
                    .put("cancelled", handle.cancelled.get()));
        } catch (Exception e) {
            if (handle.cancelled.get()) {
                try {
                    ui.push("provider.event", new JSONObject()
                            .put("requestId", requestId)
                            .put("event", "done")
                            .put("cancelled", true));
                } catch (Exception ignored) {}
            } else {
                pushStreamError(ui, requestId, "unavailable", safeMessage(e));
            }
        } finally {
            ACTIVE_STREAMS.remove(requestId, handle);
            if (connection != null) connection.disconnect();
        }
    }

    private static void pushStreamError(UiBridge ui, String requestId, String code, String message) {
        try {
            ui.push("provider.event", new JSONObject()
                    .put("requestId", requestId)
                    .put("event", "error")
                    .put("code", code)
                    .put("message", message));
        } catch (Exception ignored) {
        }
    }

    /** Completes OpenRouter PKCE pairing without returning the resulting API key to the WebView. */
    private static void exchangeOpenRouter(Context context, JSONObject payload, String sessionId, com.patel5600.missminute.mobile.bridge.Handler.Reply reply) {
        HttpURLConnection connection = null;
        try {
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "settings.modify")) throw new SecurityException("Owner session expired during provider pairing.");
            String code = payload.optString("code", "");
            String verifier = payload.optString("verifier", "");
            if (!code.matches("[\\w.-]{8,512}") || !verifier.matches("[A-Za-z0-9_-]{32,256}"))
                throw new IllegalArgumentException("OpenRouter returned invalid pairing data.");
            URL url = new URL("https://openrouter.ai/api/v1/auth/keys");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(30_000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            byte[] body = new JSONObject().put("code", code).put("code_verifier", verifier)
                    .put("code_challenge_method", "S256").toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) { out.write(body); }
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] response = input == null ? new byte[0] : readBounded(input, 64 * 1024);
            if (status < 200 || status >= 300) throw new IllegalStateException("OpenRouter could not complete pairing (HTTP " + status + ").");
            JSONObject result = new JSONObject(new String(response, StandardCharsets.UTF_8));
            String key = result.optString("key", "").trim();
            validateSecret(key);
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "settings.modify"))
                throw new SecurityException("Owner session ended while OpenRouter pairing was running; its key was discarded.");
            if (payload.optBoolean("remember", false)) {
                db(context).setProviderCredential("openrouter", key);
                SESSION_SECRETS.remove("openrouter");
            } else {
                db(context).removeProviderCredential("openrouter");
                SESSION_SECRETS.put("openrouter", key);
            }
            reply.ok(new JSONObject().put("present", true).put("remembered", payload.optBoolean("remember", false)));
        } catch (Exception e) { reply.fail("unavailable", safeMessage(e)); }
        finally { if (connection != null) connection.disconnect(); }
    }

    public static void clearSessionSecrets() {
        SESSION_SECRETS.clear();
        for (HttpURLConnection connection : ACTIVE_REQUESTS.values()) connection.disconnect();
        ACTIVE_REQUESTS.clear();
        for (StreamHandle handle : ACTIVE_STREAMS.values()) {
            handle.cancelled.set(true);
            HttpURLConnection connection = handle.connection;
            if (connection != null) connection.disconnect();
        }
        ACTIVE_STREAMS.clear();
    }

    private static void injectCredential(HttpURLConnection connection, String provider, String key) {
        if (key.isEmpty()) return;
        switch (provider) {
            case "openai": connection.setRequestProperty("Authorization", "Bearer " + key); break;
            case "openrouter": connection.setRequestProperty("Authorization", "Bearer " + key); break;
            case "anthropic": connection.setRequestProperty("x-api-key", key); break;
            case "gemini": connection.setRequestProperty("x-goog-api-key", key); break;
            case "elevenlabs": connection.setRequestProperty("xi-api-key", key); break;
            default: break;
        }
    }

    static void validateTarget(String provider, URL url) throws Exception {
        if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getUserInfo() != null || url.getPort() != -1) {
            if (!("ollama".equals(provider) && "http".equalsIgnoreCase(url.getProtocol()) && isLoopback(url.getHost()) && url.getPort() >= 1)) {
                throw new IllegalArgumentException("Provider requests must use the provider's approved HTTPS endpoint.");
            }
        }
        String host = url.getHost().toLowerCase(Locale.ROOT);
        String path = url.getPath();
        boolean allowed = ("openai".equals(provider) && "api.openai.com".equals(host))
                || ("openrouter".equals(provider) && "openrouter.ai".equals(host))
                || ("anthropic".equals(provider) && "api.anthropic.com".equals(host))
                || ("gemini".equals(provider) && "generativelanguage.googleapis.com".equals(host))
                || ("elevenlabs".equals(provider) && "api.elevenlabs.io".equals(host))
                || ("ollama".equals(provider) && isLoopback(host));
        if (!allowed) throw new IllegalArgumentException("The request host does not match the selected provider.");
        boolean allowedPath = ("openai".equals(provider) && ("/v1/responses".equals(path) || "/v1/models".equals(path) || "/v1/audio/speech".equals(path)))
                || ("openrouter".equals(provider) && ("/api/v1/chat/completions".equals(path) || "/api/v1/models".equals(path) || "/api/v1/key".equals(path)))
                || ("anthropic".equals(provider) && ("/v1/messages".equals(path) || "/v1/models".equals(path)))
                || ("gemini".equals(provider) && ("/v1beta/models".equals(path) || path.startsWith("/v1beta/models/")))
                || ("elevenlabs".equals(provider) && path.matches("/v1/text-to-speech/[A-Za-z0-9_-]{1,128}/stream"))
                || ("ollama".equals(provider) && ("/api/tags".equals(path) || "/api/show".equals(path)
                || "/v1/models".equals(path) || "/v1/chat/completions".equals(path)));
        if (!allowedPath) throw new IllegalArgumentException("The provider endpoint is outside the approved API surface.");
    }

    private static boolean isLoopback(String host) {
        try { return InetAddress.getByName(host).isLoopbackAddress(); }
        catch (Exception e) { return false; }
    }
    private static byte[] readBounded(InputStream input, int max) throws Exception {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = in.read(buffer)) != -1) { if (out.size() + n > max) throw new IllegalArgumentException("Provider response is too large."); out.write(buffer, 0, n); }
            return out.toByteArray();
        }
    }
    private static boolean containsControl(String value) {
        for (int i = 0; i < value.length(); i++) if (value.charAt(i) < 32 && value.charAt(i) != '\t') return true;
        return false;
    }
    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        if (message == null || message.isEmpty()) return "The provider request could not be completed.";
        return message.length() > 240 ? message.substring(0, 240) : message;
    }
    private static void validateSecret(String secret) {
        if (secret == null || secret.trim().isEmpty() || secret.length() > 4096 || containsControl(secret))
            throw new IllegalArgumentException("Provider credential is empty or invalid.");
    }
}
