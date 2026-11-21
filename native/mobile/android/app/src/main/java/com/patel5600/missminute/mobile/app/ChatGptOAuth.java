package com.patel5600.missminute.mobile.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.math.BigInteger;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HttpsURLConnection;

/** Native ChatGPT account flow. Tokens and refreshes stay inside the Android process. */
public final class ChatGptOAuth {
    private static final String PREFS = "chatgpt_native_v1";
    private static final String KEY_ALIAS = "miss_minutes_chatgpt_aes_v1";
    private static final String TOKEN_KEY = "credentials_gcm";
    private static final String HOST_ID = "host_id";
    private static final String CLIENT_ID = "client_id";
    private static final String AUTH_URL = "https://auth.openai.com/api/accounts/authorize";
    private static final String TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
    private static final String REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
    private static final String JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
    private static final String API_ROOT = "https://api.openai.com/v1";
    private static final String ISSUER = "https://auth.openai.com";
    private static final String RESOURCE = "https://api.openai.com/v1";
    private static final String PLAN_SCOPE = "chatgpt.tokens.use.direct";
    private static final String SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
    private static final int MAX_HTTP_BYTES = 3 * 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 120_000;
    private static final long REFRESH_SKEW_MS = 120_000L;
    private static final ExecutorService IO = Executors.newCachedThreadPool();
    private static final AtomicBoolean SIGN_IN_RUNNING = new AtomicBoolean(false);
    private static final Object TOKEN_LOCK = new Object();
    private static final ConcurrentHashMap<String, ActiveRequest> ACTIVE_REQUESTS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, ActiveRequest> ACTIVE_STREAMS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, HttpsURLConnection> NETWORK_REQUESTS = new ConcurrentHashMap<>();

    public interface Callback { void complete(JSONObject value, String error); }
    public interface StreamSink { void onEvent(JSONObject payload); }
    private interface Work { JSONObject run() throws Exception; }

    private ChatGptOAuth() {}

    public static JSONObject account(Context context) throws Exception {
        JSONObject credentials = loadCredentials(context);
        if (credentials == null) return new JSONObject().put("signedIn", false).put("email", JSONObject.NULL)
                .put("planUsage", false).put("expiresAtUnixMs", JSONObject.NULL);
        return accountView(credentials);
    }

    public static void signIn(Activity activity, Callback callback) {
        String sessionId = OwnerAuthority.ownerSessionForCapability("settings.modify");
        if (sessionId == null) {
            callback.complete(null, "Unlock Miss Minutes with the device biometric before connecting ChatGPT.");
            return;
        }
        if (!SIGN_IN_RUNNING.compareAndSet(false, true)) {
            callback.complete(null, "A ChatGPT sign-in is already in progress.");
            return;
        }
        runOwner(sessionId, (value, error) -> {
            SIGN_IN_RUNNING.set(false);
            callback.complete(value, error);
        }, () -> signInBlocking(activity, sessionId));
    }

    public static void signOut(Context context, Callback callback) {
        String sessionId = OwnerAuthority.ownerSessionForCapability("settings.modify");
        if (sessionId == null) {
            callback.complete(null, "Unlock Miss Minutes with the device biometric before disconnecting ChatGPT.");
            return;
        }
        runOwner(sessionId, callback, () -> {
            synchronized (TOKEN_LOCK) {
                JSONObject credentials = loadCredentials(context);
                if (credentials != null) {
                    String refresh = credentials.optString("refreshToken", "");
                    String clientId = credentials.optString("clientId", "");
                    if (!refresh.isEmpty() && !clientId.isEmpty()) {
                        try {
                            postForm(REVOKE_URL, form(new String[][] {
                                    {"token", refresh}, {"token_type_hint", "refresh_token"}, {"client_id", clientId}
                            }));
                        } catch (Exception ignored) { /* Local logout must still complete. */ }
                    }
                }
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(TOKEN_KEY).commit();
            }
            return new JSONObject().put("signedOut", true);
        });
    }

    public static void models(Context context, Callback callback) {
        String sessionId = OwnerAuthority.ownerSessionForCapability("ai.provider.use");
        if (sessionId == null) {
            callback.complete(null, "Unlock Miss Minutes with the device biometric to view ChatGPT models.");
            return;
        }
        runOwner(sessionId, "ai.provider.use", callback, () -> {
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use"))
                throw new SecurityException("Owner session ended before the ChatGPT model request began.");
            String token = accessToken(context);
            JSONObject response = getJson(API_ROOT + "/models", token);
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use"))
                throw new SecurityException("Owner session ended during the ChatGPT model request; its response was discarded.");
            return new JSONObject().put("models", parseModelCatalog(response));
        });
    }

    /**
     * OpenAI's Sign in with ChatGPT model catalog uses {models:[{slug,display_name,visibility}]},
     * while the standard API-key catalog uses {data:[{id}]}. Keep the official SIWC display list
     * and preserve server order; the old Android parser read only `data`, which produced an empty
     * picker even when account consent and model inference access were active.
     */
    static JSONArray parseModelCatalog(JSONObject response) throws Exception {
        JSONArray result = new JSONArray();
        JSONArray siwc = response.optJSONArray("models");
        if (siwc != null) {
            for (int i = 0; i < siwc.length(); i++) {
                JSONObject item = siwc.optJSONObject(i);
                if (item == null || !"list".equals(item.optString("visibility", ""))) continue;
                String slug = item.optString("slug", "").trim();
                if (slug.isEmpty()) continue;
                String label = item.optString("display_name", slug).trim();
                result.put(new JSONObject().put("slug", slug)
                        .put("displayName", label.isEmpty() ? slug : label));
            }
            return result;
        }

        JSONArray standard = response.optJSONArray("data");
        if (standard != null) {
            for (int i = 0; i < standard.length(); i++) {
                JSONObject item = standard.optJSONObject(i);
                if (item == null) continue;
                String id = item.optString("id", "").trim();
                if (!id.isEmpty()) result.put(new JSONObject().put("slug", id).put("displayName", id));
            }
        }
        return result;
    }

    /** The only permitted model proxy route. Caller cannot provide credentials or select a host. */
    public static void request(Context context, String requestId, String url, String method, String body, Callback callback) {
        String sessionId = OwnerAuthority.ownerSessionForCapability("ai.provider.use");
        if (sessionId == null) {
            callback.complete(null, "Unlock Miss Minutes with the device biometric before using the ChatGPT connection.");
            return;
        }
        if (!("POST".equals(method) && (API_ROOT + "/responses").equals(url))) {
            callback.complete(null, "The ChatGPT request target is not allowed.");
            return;
        }
        ActiveRequest active = new ActiveRequest();
        if (ACTIVE_REQUESTS.putIfAbsent(requestId, active) != null) {
            callback.complete(null, "A request with this identifier is already running.");
            return;
        }
        runOwner(sessionId, "ai.provider.use", callback, () -> {
            try {
                byte[] input = body.getBytes(StandardCharsets.UTF_8);
                if (input.length > MAX_HTTP_BYTES) throw new IllegalArgumentException("The ChatGPT request is too large.");
                if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use"))
                    throw new SecurityException("Owner session ended before the ChatGPT request began.");
                String token = accessToken(context);
                if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use"))
                    throw new SecurityException("Owner session ended before the ChatGPT request began.");
                if (active.cancelled.get()) throw new java.util.concurrent.CancellationException("Request cancelled.");
                HttpsURLConnection connection = (HttpsURLConnection) URI.create(url).toURL().openConnection();
                active.connection = connection;
                if (active.cancelled.get()) {
                    connection.disconnect();
                    throw new java.util.concurrent.CancellationException("Request cancelled.");
                }
                try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Accept", "text/event-stream, application/json");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(input.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(input); }
                int status = connection.getResponseCode();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                String text = stream == null ? "" : readLimited(stream, MAX_HTTP_BYTES);
                if (active.cancelled.get() || !OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use"))
                    throw new SecurityException("Owner session ended while the ChatGPT request was running; its response was discarded.");
                JSONObject headers = new JSONObject();
                String providerRequestId = connection.getHeaderField("x-request-id");
                if (providerRequestId != null) headers.put("x-request-id", providerRequestId);
                return new JSONObject().put("status", status).put("headers", headers).put("body", text);
                } finally {
                    connection.disconnect();
                }
            } finally {
                ACTIVE_REQUESTS.remove(requestId, active);
            }
        });
    }

    /** Streams incremental SSE / UTF-8 chunks via {@link StreamSink} with per-chunk owner capability checks. */
    public static void streamRequest(
            Context context,
            String requestId,
            String url,
            String method,
            String body,
            StreamSink sink,
            Callback callback) {
        String sessionId = OwnerAuthority.ownerSessionForCapability("ai.provider.use");
        if (sessionId == null) {
            callback.complete(null, "Unlock Miss Minutes with the device biometric before using the ChatGPT connection.");
            return;
        }
        if (sink == null) {
            callback.complete(null, "Streaming requires an active UI bridge.");
            return;
        }
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.-]{1,64}")) {
            callback.complete(null, "The ChatGPT stream identifier is invalid.");
            return;
        }
        if (!("POST".equals(method) && (API_ROOT + "/responses").equals(url))) {
            callback.complete(null, "The ChatGPT request target is not allowed.");
            return;
        }
        byte[] input = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
        if (input.length > MAX_HTTP_BYTES) {
            callback.complete(null, "The ChatGPT request is too large.");
            return;
        }
        ActiveRequest active = new ActiveRequest();
        if (ACTIVE_STREAMS.putIfAbsent(requestId, active) != null) {
            callback.complete(null, "A ChatGPT stream with this identifier is already running.");
            return;
        }
        try {
            JSONObject ack = new JSONObject().put("requestId", requestId).put("streaming", true);
            new Handler(Looper.getMainLooper()).post(() -> callback.complete(ack, null));
        } catch (Exception e) {
            ACTIVE_STREAMS.remove(requestId, active);
            callback.complete(null, "Could not acknowledge ChatGPT stream start.");
            return;
        }
        IO.execute(() -> {
            HttpsURLConnection connection = null;
            try {
                if (active.cancelled.get() || !OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                    emitStreamError(sink, requestId, "owner_auth_required", "Owner session ended before the ChatGPT stream began.");
                    return;
                }
                String token = accessToken(context);
                if (active.cancelled.get() || !OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                    emitStreamError(sink, requestId, "owner_auth_required", "Owner session ended before the ChatGPT stream began.");
                    return;
                }
                connection = (HttpsURLConnection) URI.create(url).toURL().openConnection();
                active.connection = connection;
                if (active.cancelled.get()) {
                    connection.disconnect();
                    emitStreamDone(sink, requestId, 0, true);
                    return;
                }
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Accept", "text/event-stream, application/json");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(input.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(input); }
                int status = connection.getResponseCode();
                if (active.cancelled.get() || !OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                    emitStreamError(sink, requestId, "owner_auth_required", "Owner session ended while connecting to ChatGPT.");
                    return;
                }
                JSONObject headers = new JSONObject();
                String providerRequestId = connection.getHeaderField("x-request-id");
                if (providerRequestId != null) headers.put("x-request-id", providerRequestId);
                sink.onEvent(new JSONObject()
                        .put("requestId", requestId)
                        .put("event", "start")
                        .put("status", status)
                        .put("headers", headers));
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (stream != null) {
                    char[] buf = new char[4096];
                    int total = 0;
                    try (Reader reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
                        int n;
                        while ((n = reader.read(buf)) != -1) {
                            if (active.cancelled.get()) break;
                            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                                emitStreamError(sink, requestId, "owner_auth_required", "Owner session ended during ChatGPT streaming.");
                                return;
                            }
                            total += n;
                            if (total > MAX_HTTP_BYTES) {
                                throw new IllegalStateException("OpenAI response exceeded the size limit.");
                            }
                            sink.onEvent(new JSONObject()
                                    .put("requestId", requestId)
                                    .put("event", "chunk")
                                    .put("data", new String(buf, 0, n)));
                        }
                    }
                }
                if (!active.cancelled.get() && !OwnerAuthority.authorizeOwnerCapability(sessionId, "ai.provider.use")) {
                    emitStreamError(sink, requestId, "owner_auth_required", "Owner session ended at ChatGPT stream completion.");
                    return;
                }
                emitStreamDone(sink, requestId, status, active.cancelled.get());
            } catch (Exception error) {
                if (active.cancelled.get()) {
                    emitStreamDone(sink, requestId, 0, true);
                } else {
                    String message = error.getMessage();
                    if (message == null || message.isEmpty()) message = "ChatGPT connection failed (" + error.getClass().getSimpleName() + ").";
                    String safe = message.replaceAll("(?i)(access_token|refresh_token|id_token|authorization)\\s*[:=]\\s*[^\\s,]+", "$1=[redacted]");
                    emitStreamError(sink, requestId, "unavailable", safe);
                }
            } finally {
                ACTIVE_STREAMS.remove(requestId, active);
                if (connection != null) connection.disconnect();
            }
        });
    }

    private static void emitStreamDone(StreamSink sink, String requestId, int status, boolean cancelled) {
        try {
            sink.onEvent(new JSONObject()
                    .put("requestId", requestId)
                    .put("event", "done")
                    .put("status", status)
                    .put("cancelled", cancelled));
        } catch (Exception ignored) {}
    }

    private static void emitStreamError(StreamSink sink, String requestId, String code, String message) {
        try {
            sink.onEvent(new JSONObject()
                    .put("requestId", requestId)
                    .put("event", "error")
                    .put("code", code)
                    .put("message", message));
        } catch (Exception ignored) {}
    }

    public static void cancel(String requestId) {
        ActiveRequest active = ACTIVE_REQUESTS.get(requestId);
        if (active != null) {
            active.cancelled.set(true);
            HttpsURLConnection connection = active.connection;
            if (connection != null) connection.disconnect();
        }
        ActiveRequest stream = ACTIVE_STREAMS.get(requestId);
        if (stream != null) {
            stream.cancelled.set(true);
            HttpsURLConnection connection = stream.connection;
            if (connection != null) connection.disconnect();
        }
    }

    /** Cancels all tracked network operations when the owner session is locked or expires. */
    public static void cancelAll() {
        for (Map.Entry<String, ActiveRequest> entry : ACTIVE_REQUESTS.entrySet()) cancel(entry.getKey());
        for (Map.Entry<String, ActiveRequest> entry : ACTIVE_STREAMS.entrySet()) cancel(entry.getKey());
        for (HttpsURLConnection connection : NETWORK_REQUESTS.values()) connection.disconnect();
        NETWORK_REQUESTS.clear();
    }

    private static final class ActiveRequest {
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        volatile HttpsURLConnection connection;
    }

    private static JSONObject signInBlocking(Activity activity, String sessionId) throws Exception {
        Context context = activity.getApplicationContext();
        JSONObject existing = loadCredentials(context);
        String hostId = hostId(context);
        String previousClient = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(CLIENT_ID, null);
        String verifier = randomToken(64);
        String challenge = base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        String state = randomToken(32);
        String nonce = randomToken(32);
        try (ServerSocket listener = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))) {
            listener.setSoTimeout(300_000);
            String redirect = "http://127.0.0.1:" + listener.getLocalPort() + "/auth/callback";
            Uri.Builder auth = Uri.parse(AUTH_URL).buildUpon()
                    .appendQueryParameter("client_id", previousClient == null ? "dynamic_agent_client" : previousClient)
                    .appendQueryParameter("ext_agent_host_id", hostId)
                    .appendQueryParameter("response_type", "code")
                    .appendQueryParameter("redirect_uri", redirect)
                    .appendQueryParameter("scope", SCOPES)
                    .appendQueryParameter("resource", RESOURCE)
                    .appendQueryParameter("state", state)
                    .appendQueryParameter("nonce", nonce)
                    .appendQueryParameter("code_challenge", challenge)
                    .appendQueryParameter("code_challenge_method", "S256");
            if (previousClient == null) auth.appendQueryParameter("agent_name_hint", "Miss Minutes");
            else if (existing != null) {
                if (existing.has("idToken")) auth.appendQueryParameter("id_token_hint", existing.optString("idToken"));
                if (existing.has("email")) auth.appendQueryParameter("login_hint", existing.optString("email"));
            }
            activity.runOnUiThread(() -> {
                try { activity.startActivity(new Intent(Intent.ACTION_VIEW, auth.build())); }
                catch (Exception error) { /* accept() times out and returns a visible failure */ }
            });
            CallbackQuery callback = awaitCallback(listener);
            if (!state.equals(callback.values.get("state"))) throw new SecurityException("The ChatGPT callback state did not match. Start again.");
            if (callback.values.containsKey("error")) throw new IllegalStateException(callback.values.get("error").equals("access_denied")
                    ? "ChatGPT sign-in was declined." : "ChatGPT sign-in failed: " + callback.values.get("error"));
            String code = callback.values.get("code");
            if (code == null || code.isEmpty()) throw new IllegalStateException("The sign-in callback did not include an authorization code.");
            String clientId = previousClient;
            String issued = callback.values.get("client_id");
            if (clientId == null) {
                if (issued == null || issued.isEmpty()) throw new IllegalStateException("OpenAI did not issue an app registration.");
                clientId = issued;
                if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(CLIENT_ID, clientId).commit()) {
                    throw new IllegalStateException("Could not save the OpenAI app registration.");
                }
            } else if (issued != null && !clientId.equals(issued)) {
                throw new SecurityException("The sign-in returned a different app registration.");
            }
            JSONObject token = postForm(TOKEN_URL, form(new String[][] {
                    {"grant_type", "authorization_code"}, {"client_id", clientId}, {"code", code},
                    {"code_verifier", verifier}, {"redirect_uri", redirect}, {"resource", RESOURCE}
            }));
            String idToken = requiredString(token, "id_token");
            JSONObject claims = verifyIdToken(idToken, clientId, nonce);
            if (existing != null && !existing.optString("subject").equals(claims.optString("sub"))) {
                throw new SecurityException("The verified ChatGPT account does not match the account already linked here.");
            }
            String refresh = token.optString("refresh_token", "");
            if (refresh.isEmpty()) throw new IllegalStateException("OpenAI did not provide a refresh token; the account was not saved.");
            String scope = token.optString("scope", "");
            String[] grantedScopes = scope.trim().isEmpty() ? new String[0] : scope.trim().split("\\s+");
            JSONObject credentials = new JSONObject()
                    .put("issuer", ISSUER).put("subject", requiredString(claims, "sub"))
                    .put("email", claims.opt("email") == null ? JSONObject.NULL : claims.opt("email"))
                    .put("clientId", clientId).put("accessToken", requiredString(token, "access_token"))
                    .put("refreshToken", refresh).put("idToken", idToken)
                    .put("tokenType", token.optString("token_type", "Bearer"))
                    .put("scope", scope).put("scopes", new JSONArray(grantedScopes))
                    .put("expiresAt", System.currentTimeMillis() + token.optLong("expires_in", 3600) * 1000L);
            if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "settings.modify"))
                throw new SecurityException("Owner session ended during ChatGPT sign-in; credentials were not saved.");
            saveCredentials(context, credentials);
            return accountView(credentials);
        } finally {
            SIGN_IN_RUNNING.set(false);
        }
    }

    private static JSONObject accountView(JSONObject c) throws Exception {
        boolean plan = false;
        JSONArray scopes = c.optJSONArray("scopes");
        if (scopes != null) for (int i = 0; i < scopes.length(); i++) if (PLAN_SCOPE.equals(scopes.optString(i))) plan = true;
        Object email = c.opt("email");
        return new JSONObject().put("signedIn", true).put("email", email == null ? JSONObject.NULL : email)
                .put("planUsage", plan).put("expiresAtUnixMs", c.optLong("expiresAt"));
    }

    private static String accessToken(Context context) throws Exception {
        synchronized (TOKEN_LOCK) {
            JSONObject c = loadCredentials(context);
            if (c == null) throw new IllegalStateException("Sign in with ChatGPT first in Settings.");
            JSONArray scopes = c.optJSONArray("scopes");
            boolean allowed = false;
            if (scopes != null) for (int i = 0; i < scopes.length(); i++) if (PLAN_SCOPE.equals(scopes.optString(i))) allowed = true;
            if (!allowed) throw new SecurityException("This ChatGPT connection did not grant plan usage. Sign in again and approve it.");
            if (c.optLong("expiresAt") - System.currentTimeMillis() > REFRESH_SKEW_MS) return c.getString("accessToken");
            String refresh = c.optString("refreshToken", "");
            if (refresh.isEmpty()) throw new IllegalStateException("The ChatGPT session expired. Sign in again.");
            JSONObject refreshed = postForm(TOKEN_URL, form(new String[][] {
                    {"grant_type", "refresh_token"}, {"client_id", c.getString("clientId")},
                    {"refresh_token", refresh}, {"resource", RESOURCE}
            }));
            c.put("accessToken", requiredString(refreshed, "access_token"));
            if (refreshed.has("refresh_token")) c.put("refreshToken", requiredString(refreshed, "refresh_token"));
            if (refreshed.has("scope")) {
                String scope = refreshed.optString("scope", "");
                c.put("scope", scope).put("scopes", new JSONArray(scope.trim().isEmpty() ? new String[0] : scope.trim().split("\\s+")));
            }
            c.put("expiresAt", System.currentTimeMillis() + refreshed.optLong("expires_in", 3600) * 1000L);
            saveCredentials(context, c);
            return c.getString("accessToken");
        }
    }

    private static JSONObject verifyIdToken(String jwt, String clientId, String nonce) throws Exception {
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) throw new SecurityException("OpenAI returned a malformed ID token.");
        JSONObject header = new JSONObject(new String(Base64.decode(parts[0], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8));
        if (!"RS256".equals(header.optString("alg"))) throw new SecurityException("OpenAI used an unsupported ID-token signature.");
        String kid = requiredString(header, "kid");
        JSONObject jwks = getJson(JWKS_URL, null);
        JSONArray keys = jwks.optJSONArray("keys");
        JSONObject jwk = null;
        if (keys != null) for (int i = 0; i < keys.length(); i++) {
            JSONObject candidate = keys.optJSONObject(i);
            if (candidate != null && kid.equals(candidate.optString("kid")) && "RSA".equals(candidate.optString("kty"))) { jwk = candidate; break; }
        }
        if (jwk == null) throw new SecurityException("OpenAI's matching token-signing key was not found.");
        BigInteger modulus = new BigInteger(1, Base64.decode(jwk.getString("n"), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
        BigInteger exponent = new BigInteger(1, Base64.decode(jwk.getString("e"), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
        RSAPublicKey key = (RSAPublicKey) KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(modulus, exponent));
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initVerify(key);
        signature.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
        byte[] signed = Base64.decode(parts[2], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        if (!signature.verify(signed)) throw new SecurityException("The OpenAI ID-token signature is invalid.");
        JSONObject claims = new JSONObject(new String(Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8));
        if (!ISSUER.equals(claims.optString("iss"))) throw new SecurityException("The ID-token issuer was not OpenAI.");
        if (!audienceMatches(claims.opt("aud"), clientId)) throw new SecurityException("The ID token was issued for another app.");
        if (claims.optLong("exp", 0) <= System.currentTimeMillis() / 1000L) throw new SecurityException("The OpenAI ID token has expired.");
        if (!nonce.equals(claims.optString("nonce"))) throw new SecurityException("The ID-token nonce did not match this sign-in.");
        if (claims.optString("sub", "").isEmpty()) throw new SecurityException("The ID token did not identify an account.");
        return claims;
    }

    private static boolean audienceMatches(Object value, String clientId) {
        if (value instanceof String) return clientId.equals(value);
        if (value instanceof JSONArray) {
            JSONArray values = (JSONArray) value;
            for (int i = 0; i < values.length(); i++) if (clientId.equals(values.optString(i))) return true;
        }
        return false;
    }

    private static JSONObject postForm(String endpoint, String body) throws Exception {
        return httpJson("POST", endpoint, "application/x-www-form-urlencoded", body, null);
    }

    private static JSONObject getJson(String endpoint, String bearer) throws Exception {
        return httpJson("GET", endpoint, null, null, bearer);
    }

    private static JSONObject httpJson(String method, String endpoint, String contentType, String body, String bearer) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) URI.create(endpoint).toURL().openConnection();
        String requestId = UUID.randomUUID().toString();
        NETWORK_REQUESTS.put(requestId, connection);
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json");
            if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", contentType);
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String response = input == null ? "{}" : readLimited(input, MAX_HTTP_BYTES);
            JSONObject result;
            try { result = new JSONObject(response); }
            catch (Exception e) { throw new IllegalStateException("OpenAI returned a malformed response (HTTP " + status + ")."); }
            if (status < 200 || status >= 300) {
                String code = result.optString("error", "");
                if (result.opt("error") instanceof JSONObject) code = result.optJSONObject("error").optString("code", "");
                throw new IllegalStateException("OpenAI request failed (HTTP " + status + (code.isEmpty() ? ")." : ", " + safeError(code) + ")."));
            }
            return result;
        } finally { NETWORK_REQUESTS.remove(requestId, connection); connection.disconnect(); }
    }

    private static String safeError(String code) {
        String safe = code.replaceAll("[^A-Za-z0-9_.-]", "");
        return safe.substring(0, Math.min(80, safe.length()));
    }

    private static JSONObject postModelRequest(Context context, String url, String body) throws Exception {
        String token = accessToken(context);
        byte[] input = body.getBytes(StandardCharsets.UTF_8);
        if (input.length > MAX_HTTP_BYTES) throw new IllegalArgumentException("The ChatGPT request is too large.");
        HttpsURLConnection connection = (HttpsURLConnection) URI.create(url).toURL().openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "text/event-stream, application/json");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(input.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(input); }
            int status = connection.getResponseCode();
            InputStream inputStream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = inputStream == null ? "" : readLimited(inputStream, MAX_HTTP_BYTES);
            JSONObject headers = new JSONObject();
            String requestId = connection.getHeaderField("x-request-id");
            if (requestId != null) headers.put("x-request-id", requestId);
            return new JSONObject().put("status", status).put("headers", headers).put("body", text);
        } finally { connection.disconnect(); }
    }

    private static JSONObject loadCredentials(Context context) throws Exception {
        String encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(TOKEN_KEY, null);
        if (encoded == null) return null;
        byte[] sealed = Base64.decode(encoded, Base64.NO_WRAP);
        if (sealed.length < 13) throw new SecurityException("The saved ChatGPT credentials are damaged; sign in again.");
        byte[] iv = new byte[12];
        System.arraycopy(sealed, 0, iv, 0, iv.length);
        byte[] ciphertext = new byte[sealed.length - iv.length];
        System.arraycopy(sealed, iv.length, ciphertext, 0, ciphertext.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, loadOrCreateEncryptionKey(), new GCMParameterSpec(128, iv));
        cipher.updateAAD("miss-minutes-chatgpt-v1".getBytes(StandardCharsets.UTF_8));
        try { return new JSONObject(new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)); }
        catch (Exception e) { throw new SecurityException("The saved ChatGPT credentials could not be decrypted; sign in again."); }
    }

    private static void saveCredentials(Context context, JSONObject credentials) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, loadOrCreateEncryptionKey());
        cipher.updateAAD("miss-minutes-chatgpt-v1".getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(credentials.toString().getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        byte[] sealed = new byte[iv.length + ciphertext.length];
        System.arraycopy(iv, 0, sealed, 0, iv.length);
        System.arraycopy(ciphertext, 0, sealed, iv.length, ciphertext.length);
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(TOKEN_KEY, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) {
            throw new IllegalStateException("Could not securely save the ChatGPT connection.");
        }
    }

    private static SecretKey loadOrCreateEncryptionKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setRandomizedEncryptionRequired(true);
                if (android.os.Build.VERSION.SDK_INT >= 28) spec.setIsStrongBoxBacked(attempt == 0);
                generator.init(spec.build());
                SecretKey key = generator.generateKey();
                KeyInfo info = (KeyInfo) javax.crypto.SecretKeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore")
                        .getKeySpec(key, KeyInfo.class);
                if (!info.isInsideSecureHardware()) {
                    store.deleteEntry(KEY_ALIAS);
                    throw new SecurityException("This device cannot protect the ChatGPT credential key in secure hardware.");
                }
                return key;
            } catch (android.security.keystore.StrongBoxUnavailableException e) {
                if (attempt == 1) throw e;
            }
        }
        throw new IllegalStateException("Could not create a protected ChatGPT credential key.");
    }

    private static String hostId(Context context) {
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String current = prefs.getString(HOST_ID, null);
        if (current != null) return current;
        String created = "urn:uuid:" + UUID.randomUUID();
        if (!prefs.edit().putString(HOST_ID, created).commit()) throw new IllegalStateException("Could not initialize the local OpenAI app identity.");
        return created;
    }

    private static final class CallbackQuery { final Map<String, String> values; CallbackQuery(Map<String, String> values) { this.values = values; } }

    private static CallbackQuery awaitCallback(ServerSocket server) throws Exception {
        long deadline = System.currentTimeMillis() + 300_000L;
        while (System.currentTimeMillis() < deadline) {
            try (Socket socket = server.accept()) {
                if (!socket.getInetAddress().isLoopbackAddress()) continue;
                socket.setSoTimeout(5_000);
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                InputStream input = socket.getInputStream();
                int last = 0, matched = 0;
                while (bytes.size() < 32 * 1024) {
                    int b = input.read();
                    if (b < 0) break;
                    bytes.write(b);
                    if ((matched == 0 && b == '\r') || (matched == 2 && b == '\r')) matched++;
                    else if ((matched == 1 && b == '\n') || (matched == 3 && b == '\n')) matched++;
                    else matched = b == '\r' ? 1 : 0;
                    if (matched == 4) break;
                }
                String request = bytes.toString(StandardCharsets.US_ASCII.name());
                String first = request.split("\\r?\\n", 2)[0];
                String[] line = first.split(" ");
                if (line.length < 2 || !"GET".equals(line[0])) { respond(socket, 400, "Bad request"); continue; }
                URI target = URI.create(line[1]);
                if (!"/auth/callback".equals(target.getPath())) { respond(socket, 404, "Not found"); continue; }
                Map<String, String> values = parseQuery(target.getRawQuery());
                boolean success = values.containsKey("code") && !values.containsKey("error");
                respond(socket, 200, success ? "ChatGPT sign-in returned to Miss Minutes. You can close this tab." : "Sign-in was cancelled. Return to Miss Minutes and try again.");
                return new CallbackQuery(values);
            }
        }
        throw new java.net.SocketTimeoutException("ChatGPT sign-in timed out. Return to Settings and try again.");
    }

    private static void respond(Socket socket, int status, String message) throws Exception {
        byte[] body = ("<!doctype html><meta charset=utf-8><title>Miss Minutes</title><h2>" + message + "</h2>").getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : " Not Found") + "\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: " + body.length + "\r\n\r\n";
        OutputStream out = socket.getOutputStream();
        out.write(head.getBytes(StandardCharsets.US_ASCII)); out.write(body); out.flush();
    }

    private static Map<String, String> parseQuery(String query) throws Exception {
        Map<String, String> result = new HashMap<>();
        if (query == null) return result;
        for (String pair : query.split("&")) {
            String[] parts = pair.split("=", 2);
            String key = URLDecoder.decode(parts[0], "UTF-8");
            String value = parts.length > 1 ? URLDecoder.decode(parts[1], "UTF-8") : "";
            if (result.containsKey(key)) throw new SecurityException("The sign-in callback contains duplicate parameters.");
            result.put(key, value);
        }
        return result;
    }

    private static String form(String[][] pairs) throws Exception {
        StringBuilder out = new StringBuilder();
        for (String[] pair : pairs) {
            if (out.length() > 0) out.append('&');
            out.append(URLEncoder.encode(pair[0], "UTF-8")).append('=').append(URLEncoder.encode(pair[1], "UTF-8"));
        }
        return out.toString();
    }

    private static String randomToken(int bytes) {
        byte[] value = new byte[bytes]; new SecureRandom().nextBytes(value); return base64Url(value);
    }
    private static String base64Url(byte[] bytes) { return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }
    private static String requiredString(JSONObject json, String key) { String value = json.optString(key, ""); if (value.isEmpty()) throw new IllegalStateException("OpenAI response is missing " + key + "."); return value; }

    private static String readLimited(InputStream input, int maxBytes) throws Exception {
        try (InputStream in = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int total = 0;
            for (int read; (read = in.read(buffer)) != -1;) {
                total += read; if (total > maxBytes) throw new IllegalStateException("OpenAI response exceeded the size limit.");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static void run(Callback callback, Work work) {
        IO.execute(() -> {
            try { JSONObject value = work.run(); new Handler(Looper.getMainLooper()).post(() -> callback.complete(value, null)); }
            catch (Exception error) {
                String message = error.getMessage();
                if (message == null || message.isEmpty()) message = "ChatGPT connection failed (" + error.getClass().getSimpleName() + ").";
                String safe = message.replaceAll("(?i)(access_token|refresh_token|id_token|authorization)\\s*[:=]\\s*[^\\s,]+", "$1=[redacted]");
                String finalMessage = safe;
                new Handler(Looper.getMainLooper()).post(() -> callback.complete(null, finalMessage));
            }
        });
    }

    private static void runOwner(String sessionId, Callback callback, Work work) {
        runOwner(sessionId, "settings.modify", callback, work);
    }

    private static void runOwner(String sessionId, String capability, Callback callback, Work work) {
        IO.execute(() -> {
            try {
                JSONObject value = work.run();
                if (!OwnerAuthority.authorizeOwnerCapability(sessionId, capability))
                    throw new SecurityException("Owner session ended before the result could be delivered.");
                new Handler(Looper.getMainLooper()).post(() -> {
                    if (OwnerAuthority.authorizeOwnerCapability(sessionId, capability)) callback.complete(value, null);
                    else callback.complete(null, "Owner session ended; the result was discarded.");
                });
            } catch (Exception error) {
                String message = error.getMessage();
                if (message == null || message.isEmpty()) message = "ChatGPT connection failed (" + error.getClass().getSimpleName() + ").";
                String safe = message.replaceAll("(?i)(access_token|refresh_token|id_token|authorization)\\s*[:=]\\s*[^\\s,]+", "$1=[redacted]");
                String finalMessage = OwnerAuthority.authorizeOwnerCapability(sessionId, capability)
                        ? safe : "Owner session ended; the request was cancelled.";
                new Handler(Looper.getMainLooper()).post(() -> callback.complete(null,
                        OwnerAuthority.authorizeOwnerCapability(sessionId, capability)
                                ? finalMessage : "Owner session ended; the request was cancelled."));
            }
        });
    }
}
