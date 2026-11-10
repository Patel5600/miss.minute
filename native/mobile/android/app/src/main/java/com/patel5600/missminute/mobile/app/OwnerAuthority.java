package com.patel5600.missminute.mobile.app;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import com.patel5600.missminute.mobile.bridge.handlers.ProviderHandlers;

import java.math.BigInteger;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.UUID;
import java.util.Arrays;
import java.util.Base64;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import org.json.JSONArray;
import org.json.JSONObject;

/** Native-only Android adapter. No WebView bridge handler exposes these methods. */
public final class OwnerAuthority {
    private static final String PREFS = "owner_authority";
    private static final String KEY_ALIAS = "miss_minutes_owner_auth_v1";
    private static final String OWNER_ID = "owner_id";
    private static final String DEVICE_ID = "device_id";
    private static final String HARDWARE_BACKED = "hardware_backed";
    private static volatile String activeSessionId;
    private static final AtomicBoolean AUTHENTICATING = new AtomicBoolean(false);
    private static final AtomicBoolean PAIRING = new AtomicBoolean(false);
    private static final ExecutorService RECOVERY_EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "mm-owner-recovery");
        thread.setDaemon(true);
        return thread;
    });
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());

    static {
        System.loadLibrary("miss_minute_identity");
    }

    private OwnerAuthority() {}

    private static native String nativeEnroll(String ownerId, String deviceId, byte[] publicKey);
    private static native String nativeRestoreDevice(String deviceId, String platform, byte[] publicKey);
    private static native String nativeRestoreRevokedDevice(String deviceId, String platform, byte[] publicKey);
    private static native String nativeRevokeDevice(String sessionId, String deviceId);
    private static native String nativeRestoreRecoveryKey(byte[] publicKey);
    private static native String nativeResetAuthority();
    private static native String nativeBootstrapRecoveryIdentity(String ownerId, byte[] recoveryPublicKey);
    private static native String nativeSetRecoveryKey(String sessionId, byte[] publicKey);
    private static native String nativeBeginDevicePairing(String sessionId, String targetDeviceId,
            String platform, byte[] publicKey);
    private static native String nativeCompleteDevicePairing(String challengeId, byte[] signature);
    private static native String nativeCancelDevicePairing();
    private static native String nativeBeginDeviceRecovery(String targetDeviceId, String platform, byte[] publicKey);
    private static native String nativeCompleteDeviceRecovery(String challengeId, byte[] signature);
    private static native String nativeCandidate();
    private static native String nativeObserveFaceMatch();
    private static native String nativeObserveVoiceMatch();
    private static native String nativeBeginAuthentication(String deviceId);
    private static native String nativeCancelAuthentication();
    private static native String nativeCompleteAuthentication(String challengeId, byte[] signature,
            boolean hardwareBacked);
    private static native String nativeStartGuest();
    private static native String nativeAuthorize(String sessionId, String commandJson);
    private static native String nativeLock();
    private static native boolean nativeOwnerSessionActive(String sessionId);
    private static native String nativeGetAuthState();
    private static native boolean nativeRequireStepUp(String sessionId);

    public interface Callback {
        void complete(String sessionId, String error);
    }

    public interface PairingCallback {
        void complete(String receipt, String error);
    }

    public interface RecoveryCallback {
        void complete(String recoveryMaterial, String error);
    }

    public static boolean isEnrolled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(OWNER_ID);
    }

    public static JSONObject identitySummary(Context context) throws Exception {
        if (!hasOwnerSession()) throw new SecurityException("Verify owner access to view trusted-device IDs.");
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject registry = OwnerRegistryStore.load(context);
        JSONArray devices = new JSONArray();
        JSONArray storedDevices = registry.optJSONArray("devices");
        if (storedDevices != null) {
            for (int i = 0; i < storedDevices.length(); i++) {
                JSONObject entry = storedDevices.optJSONObject(i);
                if (entry == null) continue;
                devices.put(new JSONObject().put("deviceId", entry.optString("deviceId", ""))
                        .put("platform", entry.optString("platform", "unknown"))
                        .put("revoked", entry.optBoolean("revoked", false))
                        .put("current", prefs.getString(DEVICE_ID, "").equals(entry.optString("deviceId", ""))));
            }
        }
        return new JSONObject().put("ownerId", prefs.getString(OWNER_ID, ""))
                .put("deviceId", prefs.getString(DEVICE_ID, ""))
                .put("recoveryConfigured", !registry.optString("recoveryPublicKey", "").isEmpty())
                .put("devices", devices);
    }

    /** Revokes a paired credential only after a fresh Keystore signature and Rust policy check. */
    public static void revokeTrustedDevice(Activity activity, String targetDeviceId, Callback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            callback.complete(null, "Android 9 or later is required for cryptographic owner verification.");
            return;
        }
        if (!hasOwnerSession()) { callback.complete(null, "Unlock owner access before revoking a device."); return; }
        String ownDeviceId = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(DEVICE_ID, "");
        if (targetDeviceId == null || targetDeviceId.isEmpty() || targetDeviceId.equals(ownDeviceId)) {
            callback.complete(null, "This screen can revoke another paired device, not the device currently in use.");
            return;
        }
        if (!requireFreshAuthentication()) {
            callback.complete(null, "Could not start a fresh owner verification. Unlock again and retry.");
            return;
        }
        authenticate(activity, (sessionId, authError) -> {
            if (authError != null || sessionId == null) {
                callback.complete(null, authError == null ? "Device verification failed." : authError);
                return;
            }
            Context app = activity.getApplicationContext();
            JSONObject previous = null;
            try {
                previous = OwnerRegistryStore.load(app);
                JSONObject next = new JSONObject(previous.toString());
                JSONArray devices = next.optJSONArray("devices");
                boolean found = false;
                if (devices != null) for (int i = 0; i < devices.length(); i++) {
                    JSONObject entry = devices.optJSONObject(i);
                    if (entry != null && targetDeviceId.equals(entry.optString("deviceId"))) {
                        entry.put("revoked", true);
                        found = true;
                    }
                }
                if (!found) throw new IllegalArgumentException("That device is not in this trusted-device registry.");
                OwnerRegistryStore.save(app, next);
                String result = nativeRevokeDevice(sessionId, targetDeviceId);
                if (!"revoked".equals(result)) throw new SecurityException("Rust authority rejected revocation: " + result);
                callback.complete(sessionId, null);
            } catch (Exception error) {
                try {
                    if (previous != null) OwnerRegistryStore.save(app, previous);
                    nativeResetAuthority();
                    activeSessionId = null;
                    restore(app);
                } catch (Exception rollbackError) { error.addSuppressed(rollbackError); }
                callback.complete(null, "Device revocation failed: " + error.getMessage());
            }
        });
    }

    /**
     * Creates a target-device request for an offline, user-mediated pairing ceremony. The request
     * contains only a public key. Its matching private key remains in this device's Android Keystore.
     */
    public static String createPairingRequest(Context context) throws Exception {
        if (isEnrolled(context)) throw new IllegalStateException("This device is already enrolled.");
        KeyPair pair = loadOrCreateKeyPair();
        KeyInfo info = keyInfo(pair);
        if (!info.isInsideSecureHardware()) throw new SecurityException("Pairing requires a hardware-protected device key.");
        String deviceId = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString("pending_pair_device_id", null);
        if (deviceId == null) {
            deviceId = UUID.randomUUID().toString().replace("-", "");
            if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString("pending_pair_device_id", deviceId).commit())
                throw new IllegalStateException("Could not save the pending device identity.");
        }
        return new JSONObject().put("type", "miss-minutes-pair-request-v1")
                .put("deviceId", deviceId).put("platform", "android")
                .put("publicKey", Base64.getEncoder().encodeToString(encodePublicKey((ECPublicKey) pair.getPublic())))
                .toString();
    }

    /** Creates a portable, passphrase-encrypted recovery kit after fresh platform verification. */
    public static void createRecoveryMaterial(Activity activity, char[] passphrase, RecoveryCallback callback) {
        if (passphrase == null || passphrase.length < 12 || passphrase.length > 256) {
            if (passphrase != null) java.util.Arrays.fill(passphrase, '\0');
            callback.complete(null, "Use a recovery passphrase between 12 and 256 characters.");
            return;
        }
        if (!authorizeOwnerCapability("owner.profile.modify")) {
            java.util.Arrays.fill(passphrase, '\0');
            callback.complete(null, "Unlock owner access before setting up recovery.");
            return;
        }
        if (!hasOwnerSession()) {
            java.util.Arrays.fill(passphrase, '\0');
            callback.complete(null, "Unlock owner access before setting up recovery.");
            return;
        }
        RECOVERY_EXECUTOR.execute(() -> {
            String ownerId = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(OWNER_ID, "");
            String material;
            byte[] publicKey;
            try {
                KeyPair recoveryPair = RecoveryMaterialCodec.generateKeyPair();
                publicKey = RecoveryMaterialCodec.encodePublicKey((ECPublicKey) recoveryPair.getPublic());
                material = RecoveryMaterialCodec.create(ownerId, recoveryPair, passphrase);
            } catch (Exception error) {
                java.util.Arrays.fill(passphrase, '\0');
                MAIN_HANDLER.post(() -> callback.complete(null, "Could not create recovery material: " + error.getMessage()));
                return;
            }
            java.util.Arrays.fill(passphrase, '\0');
            MAIN_HANDLER.post(() -> {
                if (activity.isFinishing() || activity.isDestroyed()) {
                    callback.complete(null, "Keep the dashboard open to finish recovery setup.");
                    return;
                }
                if (!hasOwnerSession() || !requireFreshAuthentication()) {
                    callback.complete(null, "Fresh device verification is required to set up recovery.");
                    return;
                }
                authenticate(activity, (sessionId, authError) -> {
                    if (authError != null || sessionId == null) {
                        callback.complete(null, authError == null ? "Device verification failed." : authError);
                        return;
                    }
                    try {
                        Context app = activity.getApplicationContext();
                        JSONObject previousRegistry = OwnerRegistryStore.load(app);
                        JSONObject registry = new JSONObject(previousRegistry.toString())
                                .put("recoveryPublicKey", Base64.getEncoder().encodeToString(publicKey));
                        String installed = nativeSetRecoveryKey(sessionId, publicKey);
                        if (!"saved".equals(installed)) throw new SecurityException("Rust authority rejected the recovery credential.");
                        try {
                            OwnerRegistryStore.save(app, registry);
                        } catch (Exception persistError) {
                            nativeResetAuthority();
                            activeSessionId = null;
                            try { restore(app); }
                            catch (Exception restoreError) { persistError.addSuppressed(restoreError); }
                            throw persistError;
                        }
                        callback.complete(material, null);
                    } catch (Exception error) {
                        callback.complete(null, "Could not save recovery credential: " + error.getMessage());
                    }
                });
            });
        });
    }

    /** Restores a replacement Android device from the offline key after a one-use signed challenge. */
    public static String recoverDevice(Context context, String material, char[] passphrase) throws Exception {
        if (isEnrolled(context)) throw new IllegalStateException("This device is already enrolled; use authenticated device pairing.");
        RecoveryMaterialCodec.Credential recovery;
        try {
            recovery = RecoveryMaterialCodec.open(material, passphrase);
        } finally {
            java.util.Arrays.fill(passphrase, '\0');
        }
        KeyPair devicePair = loadOrCreateKeyPair();
        KeyInfo info = keyInfo(devicePair);
        if (!info.isInsideSecureHardware()) {
            deleteKey();
            throw new SecurityException("Recovery requires a hardware-protected Android device key.");
        }
        String deviceId = UUID.randomUUID().toString().replace("-", "");
        byte[] devicePublic = encodePublicKey((ECPublicKey) devicePair.getPublic());
        boolean bootstrapped = false;
        boolean registrySaved = false;
        JSONObject previousRegistry = OwnerRegistryStore.load(context);
        try {
            nativeResetAuthority();
            String initialized = nativeBootstrapRecoveryIdentity(recovery.ownerId, recovery.publicKey);
            if (!"bootstrapped".equals(initialized)) throw new SecurityException("Rust authority rejected the recovery identity.");
            bootstrapped = true;
            JSONObject challenge = new JSONObject(nativeBeginDeviceRecovery(deviceId, "android", devicePublic));
            if (challenge.optString("error", "").length() > 0) throw new SecurityException("Rust authority rejected the recovery challenge.");
            byte[] challengeBytes = decodeHex(challenge.getString("challenge"));
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(recovery.privateKey);
            signer.update(challengeBytes);
            byte[] signature = signer.sign();
            String completed = nativeCompleteDeviceRecovery(challenge.getString("challengeId"), signature);
            if (!deviceId.equals(completed)) throw new SecurityException("Offline recovery signature was rejected.");

            JSONObject registry = OwnerRegistryStore.empty()
                    .put("ownerId", recovery.ownerId)
                    .put("recoveryPublicKey", Base64.getEncoder().encodeToString(recovery.publicKey));
            JSONArray devices = registry.optJSONArray("devices");
            devices.put(deviceRecord(deviceId, "android", devicePublic));
            OwnerRegistryStore.save(context, registry);
            registrySaved = true;
            boolean committed = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(OWNER_ID, recovery.ownerId).putString(DEVICE_ID, deviceId)
                    .putBoolean(HARDWARE_BACKED, true).commit();
            if (!committed) throw new IllegalStateException("Could not commit the recovered device identity.");
            activeSessionId = null;
            return "recovered";
        } catch (Exception error) {
            if (bootstrapped) nativeResetAuthority();
            if (registrySaved) {
                try { OwnerRegistryStore.save(context, previousRegistry); }
                catch (Exception rollbackError) { error.addSuppressed(rollbackError); }
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .remove(OWNER_ID).remove(DEVICE_ID).remove(HARDWARE_BACKED).commit();
            throw error;
        }
    }

    /** Signs the Rust-created pairing challenge with the enrolled device key after fresh biometrics. */
    public static void approvePairingRequest(Activity activity, String requestJson, PairingCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            callback.complete(null, "Android 9 or later is required for biometric-gated device pairing.");
            return;
        }
        if (!hasOwnerSession()) { callback.complete(null, "Unlock the owner session before pairing a device."); return; }
        if (!PAIRING.compareAndSet(false, true)) { callback.complete(null, "A device-pairing request is already in progress."); return; }
        AtomicBoolean completed = new AtomicBoolean(false);
        PairingCallback finish = (receipt, error) -> {
            if (completed.compareAndSet(false, true)) {
                PAIRING.set(false);
                callback.complete(receipt, error);
            }
        };
        boolean challengeStarted = false;
        try {
            JSONObject request = new JSONObject(requestJson);
            if (!"miss-minutes-pair-request-v1".equals(request.optString("type")))
                throw new IllegalArgumentException("This is not a Miss Minutes pairing request.");
            String targetId = request.getString("deviceId");
            String platform = request.getString("platform");
            byte[] targetKey = Base64.getDecoder().decode(request.getString("publicKey"));
            validatePairingIdentity(targetId, platform, targetKey);
            String sessionId = activeSessionId;
            String challengeJson = nativeBeginDevicePairing(sessionId, targetId, platform, targetKey);
            if (challengeJson.startsWith("error:")) throw new IllegalStateException(challengeJson.substring(6));
            challengeStarted = true;
            JSONObject challenge = new JSONObject(challengeJson);
            byte[] challengeBytes = decodeHex(challenge.getString("challenge"));
            KeyPair sourcePair = new KeyPair(keyStore().getCertificate(KEY_ALIAS).getPublicKey(),
                    (java.security.PrivateKey) keyStore().getKey(KEY_ALIAS, null));
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(sourcePair.getPrivate());
            signer.update(challengeBytes);
            showPairingBiometric(activity, signer, challenge, targetKey, encodePublicKey((ECPublicKey) sourcePair.getPublic()), finish);
        } catch (Exception error) {
            if (challengeStarted) nativeCancelDevicePairing();
            finish.complete(null, "Could not start secure pairing: " + error.getMessage());
        }
    }

    /** Verifies an owner-signed pairing receipt before this new Android device trusts the owner registry. */
    public static String acceptPairingReceipt(Context context, String receiptJson) throws Exception {
        if (isEnrolled(context)) throw new IllegalStateException("This device is already enrolled.");
        JSONObject receipt = new JSONObject(receiptJson);
        if (!"miss-minutes-pair-receipt-v1".equals(receipt.optString("type")))
            throw new IllegalArgumentException("This is not a Miss Minutes pairing receipt.");
        String ownerId = receipt.getString("ownerId");
        String sourceId = receipt.getString("sourceDeviceId");
        String targetId = receipt.getString("targetDeviceId");
        String platform = receipt.getString("platform");
        if (!"android".equals(platform)) throw new IllegalArgumentException("This receipt was created for a different platform.");
        byte[] targetKey = Base64.getDecoder().decode(receipt.getString("targetPublicKey"));
        byte[] sourceKey = Base64.getDecoder().decode(receipt.getString("sourcePublicKey"));
        String sourcePlatform = receipt.optString("sourcePlatform", "android");
        if (!("android".equals(sourcePlatform) || "windows".equals(sourcePlatform)))
            throw new IllegalArgumentException("The receipt source platform is unsupported.");
        byte[] challenge = "windows".equals(sourcePlatform)
                ? Base64.getDecoder().decode(receipt.getString("challenge"))
                : decodeHex(receipt.getString("challenge"));
        byte[] nonce = "windows".equals(sourcePlatform)
                ? Base64.getDecoder().decode(receipt.getString("nonce"))
                : decodeHex(receipt.getString("nonce"));
        validatePairingIdentity(targetId, platform, targetKey);
        if (ownerId.isEmpty() || sourceId.isEmpty() || sourceId.equals(targetId) || sourceKey.length != 65 || sourceKey[0] != 4)
            throw new IllegalArgumentException("The pairing receipt identity is invalid.");
        String pendingId = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("pending_pair_device_id", null);
        if (pendingId == null || !pendingId.equals(targetId))
            throw new SecurityException("This pairing receipt was not issued for this device's pending key.");
        KeyPair localPair = loadOrCreateKeyPair();
        if (!MessageDigest.isEqual(targetKey, encodePublicKey((ECPublicKey) localPair.getPublic())))
            throw new SecurityException("The receipt public key does not match this device's protected key.");
        String challengeId = receipt.getString("challengeId");
        byte[] expected = pairingChallengeBytes(ownerId, sourceId, targetId, platform, targetKey, challengeId, nonce);
        if (!MessageDigest.isEqual(expected, challenge)) throw new SecurityException("The pairing challenge fields were altered.");
        if ("windows".equals(sourcePlatform)) {
            WindowsWebAuthnProof.verify(sourceKey, Base64.getDecoder().decode(receipt.getString("sourceCredentialId")),
                    challenge, receipt.getJSONObject("webauthnAssertion"));
        } else {
            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(decodeP256PublicKey(sourceKey));
            verifier.update(challenge);
            if (!verifier.verify(Base64.getDecoder().decode(receipt.getString("signature"))))
                throw new SecurityException("The trusted device signature is invalid.");
        }

        JSONObject previousRegistry = OwnerRegistryStore.load(context);
        boolean nativeEnrolled = false;
        try {
            String enrolled = nativeEnroll(ownerId, targetId, targetKey);
            if (enrolled.startsWith("error:")) throw new IllegalStateException("Rust authority enrollment failed: " + enrolled.substring(6));
            nativeEnrolled = true;
            String restored = nativeRestoreDevice(sourceId, sourcePlatform, sourceKey);
            if (!"restored".equals(restored)) throw new IllegalStateException("Could not restore the pairing device credential.");
            JSONObject registry = OwnerRegistryStore.empty();
            JSONArray devices = new JSONArray();
            devices.put(deviceRecord(targetId, "android", targetKey));
            devices.put(deviceRecord(sourceId, sourcePlatform, sourceKey));
            registry.put("ownerId", ownerId).put("devices", devices);
            String recoveryPublicKey = receipt.optString("recoveryPublicKey", "");
            if (!recoveryPublicKey.isEmpty()) {
                byte[] recovery = Base64.getDecoder().decode(recoveryPublicKey);
                if (!"restored".equals(nativeRestoreRecoveryKey(recovery))) throw new IllegalStateException("Could not restore the recovery credential.");
                registry.put("recoveryPublicKey", recoveryPublicKey);
            }
            OwnerRegistryStore.save(context, registry);
            boolean committed = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(OWNER_ID, ownerId).putString(DEVICE_ID, targetId).putBoolean(HARDWARE_BACKED, true)
                    .remove("pending_pair_device_id").commit();
            if (!committed) throw new IllegalStateException("Could not commit the paired-device identity.");
            return "paired";
        } catch (Exception error) {
            if (nativeEnrolled) nativeResetAuthority();
            try { OwnerRegistryStore.save(context, previousRegistry); }
            catch (Exception rollbackError) { error.addSuppressed(rollbackError); }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .remove(OWNER_ID).remove(DEVICE_ID).remove(HARDWARE_BACKED).commit();
            throw error;
        }
    }

    private static JSONObject deviceRecord(String id, String platform, byte[] key) throws Exception {
        return new JSONObject().put("deviceId", id).put("platform", platform)
                .put("publicKey", Base64.getEncoder().encodeToString(key));
    }

    private static void validatePairingIdentity(String id, String platform, byte[] publicKey) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{16,64}")) throw new IllegalArgumentException("Device ID is invalid.");
        if (!("android".equals(platform) || "windows".equals(platform) || "linux".equals(platform)))
            throw new IllegalArgumentException("Platform is not supported.");
        if (publicKey == null || publicKey.length != 65 || publicKey[0] != 4)
            throw new IllegalArgumentException("Device public key is invalid.");
    }

    private static java.security.PublicKey decodeP256PublicKey(byte[] raw) throws Exception {
        byte[] prefix = new byte[] {0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, (byte)0x86, 0x48, (byte)0xce,
                0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, (byte)0x86, 0x48, (byte)0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00};
        byte[] encoded = new byte[prefix.length + raw.length];
        System.arraycopy(prefix, 0, encoded, 0, prefix.length);
        System.arraycopy(raw, 0, encoded, prefix.length, raw.length);
        return KeyFactory.getInstance("EC").generatePublic(new java.security.spec.X509EncodedKeySpec(encoded));
    }

    private static byte[] pairingChallengeBytes(String ownerId, String sourceId, String targetId,
            String platform, byte[] targetKey, String challengeId, byte[] nonce) throws Exception {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        bytes.write("miss-minutes-device-pair-v1\0".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        appendField(bytes, ownerId.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        appendField(bytes, sourceId.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        appendField(bytes, targetId.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        appendField(bytes, platform.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        appendField(bytes, targetKey);
        appendField(bytes, challengeId.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        appendField(bytes, nonce);
        return bytes.toByteArray();
    }

    private static void appendField(java.io.ByteArrayOutputStream output, byte[] field) throws Exception {
        output.write(java.nio.ByteBuffer.allocate(4).putInt(field.length).array());
        output.write(field);
    }

    private static void showPairingBiometric(Activity activity, Signature signer, JSONObject challenge,
            byte[] targetKey, byte[] sourceKey, PairingCallback callback) {
        Executor executor = activity.getMainExecutor();
        android.hardware.biometrics.BiometricPrompt prompt = new android.hardware.biometrics.BiometricPrompt.Builder(activity)
                .setTitle("Approve device pairing")
                .setSubtitle("A new device will join your Miss Minutes owner identity")
                .setNegativeButton("Cancel", executor, (dialog, which) -> {
                    nativeCancelDevicePairing(); callback.complete(null, "Device pairing was cancelled.");
                }).build();
        prompt.authenticate(new android.hardware.biometrics.BiometricPrompt.CryptoObject(signer),
                new CancellationSignal(), executor, new android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationError(int code, CharSequence message) {
                        nativeCancelDevicePairing(); callback.complete(null, "Pairing verification failed: " + message);
                    }
                    @Override public void onAuthenticationSucceeded(android.hardware.biometrics.BiometricPrompt.AuthenticationResult result) {
                        try {
                            byte[] signature = result.getCryptoObject().getSignature().sign();
                            String targetId = challenge.getString("targetDeviceId");
                            String completed = nativeCompleteDevicePairing(challenge.getString("challengeId"), signature);
                            if (completed.startsWith("error:") || !targetId.equals(completed))
                                throw new SecurityException("Rust authority rejected the pairing proof.");
                            JSONObject registry = OwnerRegistryStore.load(activity);
                            JSONArray devices = registry.optJSONArray("devices");
                            if (devices == null) devices = new JSONArray();
                            devices.put(deviceRecord(targetId, challenge.getString("platform"), targetKey));
                            registry.put("ownerId", challenge.getString("ownerId")).put("devices", devices);
                            OwnerRegistryStore.save(activity, registry);
                            String recovery = registry.optString("recoveryPublicKey", "");
                            JSONObject receipt = new JSONObject().put("type", "miss-minutes-pair-receipt-v1")
                                    .put("ownerId", challenge.getString("ownerId"))
                                    .put("sourceDeviceId", challenge.getString("sourceDeviceId"))
                                    .put("sourcePlatform", "android")
                                    .put("targetDeviceId", targetId).put("platform", challenge.getString("platform"))
                                    .put("targetPublicKey", Base64.getEncoder().encodeToString(targetKey))
                                    .put("sourcePublicKey", Base64.getEncoder().encodeToString(sourceKey))
                                    .put("challengeId", challenge.getString("challengeId"))
                                    .put("nonce", challenge.getString("nonce"))
                                    .put("challenge", challenge.getString("challenge"))
                                    .put("signature", Base64.getEncoder().encodeToString(signature));
                            if (!recovery.isEmpty()) receipt.put("recoveryPublicKey", recovery);
                            callback.complete(receipt.toString(), null);
                        } catch (Exception error) {
                            nativeCancelDevicePairing();
                            nativeResetAuthority();
                            activeSessionId = null;
                            restore(activity.getApplicationContext());
                            callback.complete(null, "Pairing did not complete: " + error.getMessage());
                        }
                    }
                });
    }

    /** Deliberate first-device enrollment followed immediately by biometric-gated challenge signing. */
    public static void enrollAndAuthenticate(Activity activity, Callback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            callback.complete(null, "Android 9 or later is required for a cryptographic biometric prompt.");
            return;
        }
        try {
            KeyPair pair = loadOrCreateKeyPair();
            KeyInfo info = keyInfo(pair);
            if (!info.isInsideSecureHardware()) {
                deleteKey();
                callback.complete(null, "This device does not provide hardware-backed key protection.");
                return;
            }
            Context app = activity.getApplicationContext();
            android.content.SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String ownerId = prefs.getString(OWNER_ID, UUID.randomUUID().toString().replace("-", ""));
            String deviceId = prefs.getString(DEVICE_ID, UUID.randomUUID().toString().replace("-", ""));
            String enrolled = nativeEnroll(ownerId, deviceId, encodePublicKey((ECPublicKey) pair.getPublic()));
            if (enrolled.startsWith("error:")) {
                callback.complete(null, "Rust authority enrollment failed: " + enrolled.substring(6));
                return;
            }
            if (!prefs.edit().putString(OWNER_ID, ownerId).putString(DEVICE_ID, deviceId)
                    .putBoolean(HARDWARE_BACKED, true).commit()) {
                nativeLock();
                callback.complete(null, "Could not persist the device enrollment record.");
                return;
            }
            persistDevice(app, ownerId, deviceId, "android", encodePublicKey((ECPublicKey) pair.getPublic()));
            authenticate(activity, deviceId, callback);
        } catch (Exception e) {
            callback.complete(null, "Secure owner enrollment failed: " + e.getClass().getSimpleName());
        }
    }

    /** Restore public enrollment state after process start; this does not authenticate a user. */
    public static String restore(Context context) {
        if (!isEnrolled(context)) return "unenrolled";
        try {
            KeyStore store = keyStore();
            if (!store.containsAlias(KEY_ALIAS)) return "device_untrusted";
            android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            KeyPair pair = new KeyPair(store.getCertificate(KEY_ALIAS).getPublicKey(),
                    (java.security.PrivateKey) store.getKey(KEY_ALIAS, null));
            if (!keyInfo(pair).isInsideSecureHardware()) return "device_untrusted";
            String ownerId = prefs.getString(OWNER_ID, "");
            String deviceId = prefs.getString(DEVICE_ID, "");
            byte[] publicKey = encodePublicKey((ECPublicKey) pair.getPublic());
            String restored = nativeEnroll(ownerId, deviceId, publicKey);
            if (restored.startsWith("error:")) return restored;
            JSONObject registry = OwnerRegistryStore.load(context);
            JSONArray devices = registry.optJSONArray("devices");
            boolean hasCurrent = false;
            if (devices == null) devices = new JSONArray();
            for (int i = 0; i < devices.length(); i++) {
                JSONObject entry = devices.optJSONObject(i);
                if (entry == null) continue;
                String id = entry.optString("deviceId", "");
                if (deviceId.equals(id)) {
                    if (entry.optBoolean("revoked", false)) return "device_untrusted";
                    hasCurrent = true;
                    continue;
                }
                byte[] keyBytes = Base64.getDecoder().decode(entry.getString("publicKey"));
                String status = entry.optBoolean("revoked", false)
                        ? nativeRestoreRevokedDevice(id, entry.getString("platform"), keyBytes)
                        : nativeRestoreDevice(id, entry.getString("platform"), keyBytes);
                if (!((entry.optBoolean("revoked", false) && "revoked".equals(status))
                        || (!entry.optBoolean("revoked", false) && "restored".equals(status)))) return "device_untrusted";
            }
            if (!hasCurrent) persistDevice(context, ownerId, deviceId, "android", publicKey);
            String recovery = registry.optString("recoveryPublicKey", "");
            if (!recovery.isEmpty()) {
                String status = nativeRestoreRecoveryKey(Base64.getDecoder().decode(recovery));
                if (!"restored".equals(status)) return "device_untrusted";
            }
            return restored;
        } catch (Exception e) {
            return "device_untrusted";
        }
    }

    private static void persistDevice(Context context, String ownerId, String deviceId,
            String platform, byte[] publicKey) throws Exception {
        JSONObject registry = OwnerRegistryStore.load(context);
        JSONArray devices = registry.optJSONArray("devices");
        if (devices == null) devices = new JSONArray();
        for (int i = 0; i < devices.length(); i++) {
            JSONObject entry = devices.optJSONObject(i);
            if (entry != null && deviceId.equals(entry.optString("deviceId"))) return;
        }
        devices.put(new JSONObject().put("deviceId", deviceId).put("platform", platform)
                .put("publicKey", Base64.getEncoder().encodeToString(publicKey)));
        registry.put("devices", devices).put("ownerId", ownerId);
        OwnerRegistryStore.save(context, registry);
    }

    public static void authenticate(Activity activity, Callback callback) {
        android.content.SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String deviceId = prefs.getString(DEVICE_ID, null);
        if (deviceId == null) {
            callback.complete(null, "This device is not enrolled.");
            return;
        }
        authenticate(activity, deviceId, callback);
    }

    private static void authenticate(Activity activity, String deviceId, Callback callback) {
        if (!AUTHENTICATING.compareAndSet(false, true)) {
            callback.complete(null, "Owner verification is already in progress.");
            return;
        }
        AtomicBoolean completed = new AtomicBoolean(false);
        Callback finish = (sessionId, error) -> {
            if (completed.compareAndSet(false, true)) {
                AUTHENTICATING.set(false);
                callback.complete(sessionId, error);
            }
        };
        try {
            String candidate = nativeCandidate();
            if (!"owner_candidate".equals(candidate)) {
                finish.complete(null, "Owner candidate state is unavailable.");
                return;
            }
            String challenge = nativeBeginAuthentication(deviceId);
            if (challenge.startsWith("error:")) {
                finish.complete(null, "Rust challenge rejected: " + challenge.substring(6));
                return;
            }
            int separator = challenge.indexOf('\n');
            if (separator <= 0) throw new IllegalStateException("Malformed native challenge.");
            String challengeId = challenge.substring(0, separator);
            byte[] challengeBytes = decodeHex(challenge.substring(separator + 1));
            KeyStore store = keyStore();
            java.security.PrivateKey privateKey = (java.security.PrivateKey) store.getKey(KEY_ALIAS, null);
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(privateKey);
            signer.update(challengeBytes);

            Api28Biometric.show(activity, signer, challengeId, finish);
        } catch (Exception e) {
            nativeCancelAuthentication();
            finish.complete(null, "Secure authentication is unavailable: " + e.getClass().getSimpleName());
        }
    }

    public static void lock() {
        activeSessionId = null;
        nativeLock();
        ProviderHandlers.clearSessionSecrets();
        com.patel5600.missminute.mobile.app.ChatGptOAuth.cancelAll();
    }

    public static boolean hasOwnerSession() {
        String sessionId = activeSessionId;
        if (sessionId == null) return false;
        boolean active = nativeOwnerSessionActive(sessionId);
        if (!active && sessionId.equals(activeSessionId)) {
            activeSessionId = null;
            ProviderHandlers.clearSessionSecrets();
            com.patel5600.missminute.mobile.app.ChatGptOAuth.cancelAll();
        }
        return active;
    }

    /** Snapshot identifier used to bind a long-running renderer turn to its initiating session. */
    public static String currentOwnerSessionId() {
        String sessionId = activeSessionId;
        if (sessionId == null || !nativeOwnerSessionActive(sessionId)
                || !sessionId.equals(activeSessionId)) return null;
        return sessionId;
    }

    /** Used by application lifecycle locking to avoid revoking a session while Android's auth UI is active. */
    public static boolean isAuthenticationInProgress() {
        return AUTHENTICATING.get();
    }

    /**
     * Returns {@code true} when the authority engine is in the {@code OwnerCandidate} state —
     * i.e., a local face or speaker recognition signal was observed but no authenticated session
     * is active yet. This is safe to call from any thread; it reads only the Rust state machine.
     */
    public static boolean isOwnerCandidate() {
        try {
            return "owner_candidate".equals(nativeGetAuthState());
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * Returns the raw auth-state string from the Rust authority engine.
     * Values: unenrolled, locked, owner_candidate, authentication_pending,
     *         owner_authenticated, step_up_required, guest_active, revoked, device_untrusted.
     */
    public static String getAuthState() {
        try {
            return nativeGetAuthState();
        } catch (RuntimeException e) {
            return "locked";
        }
    }

    /** Records a local visual match as a prediction signal only; it grants no capability. */
    public static boolean reportOwnerFaceCandidate() {
        try {
            return "owner_candidate".equals(nativeObserveFaceMatch());
        } catch (RuntimeException error) {
            return false;
        }
    }

    /** Records a local speaker match as a prediction signal only; it grants no capability. */
    public static boolean reportOwnerVoiceCandidate() {
        try {
            return "owner_candidate".equals(nativeObserveVoiceMatch());
        } catch (RuntimeException error) {
            return false;
        }
    }

    /** Invalidates the current session and begins a fresh biometric challenge path. */
    public static boolean requireFreshAuthentication() {
        String sessionId = activeSessionId;
        if (sessionId == null || !nativeRequireStepUp(sessionId)) return false;
        activeSessionId = null;
        ProviderHandlers.clearSessionSecrets();
        com.patel5600.missminute.mobile.app.ChatGptOAuth.cancelAll();
        return true;
    }

    /** Authorizes a fixed native capability; callers cannot supply a principal or session ID. */
    public static boolean authorizeOwnerCapability(String capability) {
        return authorizeOwnerCapability(activeSessionId, capability);
    }

    /** Captures the exact authenticated session for work that may outlive the current UI turn. */
    public static String ownerSessionForCapability(String capability) {
        String sessionId = activeSessionId;
        return authorizeOwnerCapability(sessionId, capability) ? sessionId : null;
    }

    /** Rechecks a captured session, so a later unlock cannot adopt work started by an older one. */
    public static boolean authorizeOwnerCapability(String sessionId, String capability) {
        if (sessionId == null || !("settings.modify".equals(capability)
                || "device.control".equals(capability)
                || "owner.profile.modify".equals(capability)
                || "memory.private.read".equals(capability)
                || "memory.private.write".equals(capability)
                || "files.private.read".equals(capability))) {
            return false;
        }
        try {
            JSONObject command = new JSONObject()
                    .put("origin", "user_input")
                    .put("capability", capability)
                    .put("target", "")
                    .put("risk", "low")
                    .put("requires_confirmation", false);
            String response = nativeAuthorize(sessionId, command.toString());
            if (response.startsWith("error:")) {
                invalidateIfCurrent(sessionId);
                return false;
            }
            boolean allowed = "allow".equals(new JSONObject(response).optString("decision"));
            if (!allowed) invalidateIfCurrent(sessionId);
            return allowed;
        } catch (Exception e) {
            invalidateIfCurrent(sessionId);
            return false;
        }
    }

    private static void invalidateIfCurrent(String sessionId) {
        if (sessionId == null || !sessionId.equals(activeSessionId)) return;
        activeSessionId = null;
        nativeLock();
        ProviderHandlers.clearSessionSecrets();
        com.patel5600.missminute.mobile.app.ChatGptOAuth.cancelAll();
    }

    private static KeyPair loadOrCreateKeyPair() throws Exception {
        KeyStore store = keyStore();
        if (store.containsAlias(KEY_ALIAS)) {
            return new KeyPair(store.getCertificate(KEY_ALIAS).getPublicKey(),
                    (java.security.PrivateKey) store.getKey(KEY_ALIAS, null));
        }
        return generateKeyPair(true);
    }

    private static KeyPair generateKeyPair(boolean strongBox) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(0,
                    KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        } else {
            spec.setUserAuthenticationValidityDurationSeconds(-1);
        }
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true);
        generator.initialize(spec.build());
        try {
            return generator.generateKeyPair();
        } catch (android.security.keystore.StrongBoxUnavailableException e) {
            deleteKey();
            if (strongBox) return generateKeyPair(false); // Protected TEE/Keystore fallback.
            throw e;
        }
    }

    private static KeyInfo keyInfo(KeyPair pair) throws Exception {
        KeyFactory factory = KeyFactory.getInstance(pair.getPrivate().getAlgorithm(), "AndroidKeyStore");
        return factory.getKeySpec(pair.getPrivate(), KeyInfo.class);
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    private static void deleteKey() throws Exception {
        KeyStore store = keyStore();
        if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
    }

    private static byte[] encodePublicKey(ECPublicKey key) {
        byte[] point = new byte[65];
        point[0] = 0x04;
        putCoordinate(key.getW().getAffineX(), point, 1);
        putCoordinate(key.getW().getAffineY(), point, 33);
        return point;
    }

    private static void putCoordinate(BigInteger coordinate, byte[] output, int offset) {
        byte[] encoded = coordinate.toByteArray();
        int sourceOffset = encoded.length > 32 ? encoded.length - 32 : 0;
        int length = Math.min(32, encoded.length);
        System.arraycopy(encoded, sourceOffset, output, offset + 32 - length, length);
    }

    private static byte[] decodeHex(String value) {
        if ((value.length() & 1) != 0) throw new IllegalArgumentException("Malformed challenge.");
        byte[] decoded = new byte[value.length() / 2];
        for (int i = 0; i < decoded.length; i++) {
            int high = Character.digit(value.charAt(i * 2), 16);
            int low = Character.digit(value.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) throw new IllegalArgumentException("Malformed challenge.");
            decoded[i] = (byte) ((high << 4) | low);
        }
        return decoded;
    }

    /** Isolated so Android 8.x can load the rest of this class without resolving API 28 types. */
    private static final class Api28Biometric {
        static void show(Activity activity, Signature signer, String challengeId, Callback callback) {
            Executor executor = activity.getMainExecutor();
            android.hardware.biometrics.BiometricPrompt.Builder builder = new android.hardware.biometrics.BiometricPrompt.Builder(activity)
                    .setTitle("Verify your Miss Minutes owner profile")
                    .setSubtitle("Use this device's strong biometric" );
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setSubtitle("Use this device's strong biometric or device PIN, pattern, or password");
                builder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG
                        | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                builder.setNegativeButton("Cancel", executor, (dialog, which) -> {
                    nativeCancelAuthentication();
                    callback.complete(null, "Authentication cancelled.");
                });
            }
            android.hardware.biometrics.BiometricPrompt prompt = builder.build();
            prompt.authenticate(new android.hardware.biometrics.BiometricPrompt.CryptoObject(signer),
                    new CancellationSignal(), executor,
                    new android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationError(int errorCode, CharSequence errString) {
                            nativeCancelAuthentication();
                            callback.complete(null, "Biometric verification failed: " + errString);
                        }

                        @Override
                        public void onAuthenticationSucceeded(
                                android.hardware.biometrics.BiometricPrompt.AuthenticationResult result) {
                            try {
                                Signature authenticatedSigner = result.getCryptoObject().getSignature();
                                byte[] signature = authenticatedSigner.sign();
                                String sessionId = nativeCompleteAuthentication(challengeId, signature, true);
                                if (sessionId.startsWith("error:")) {
                                    callback.complete(null, "Rust rejected the signed challenge: " + sessionId.substring(6));
                                } else {
                                    activeSessionId = sessionId;
                                    callback.complete(sessionId, null);
                                }
                            } catch (Exception e) {
                                nativeCancelAuthentication();
                                callback.complete(null, "Could not complete the device signature.");
                            }
                        }
                    });
        }
    }
}
