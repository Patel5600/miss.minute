package com.patel5600.missminute.mobile.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Integrity-protected local registry of public device credentials and recovery verifier. */
final class OwnerRegistryStore {
    private static final String PREFS = "owner_authority_registry";
    private static final String RECORD = "sealed_v1";
    private static final String KEY_ALIAS = "miss_minutes_owner_registry_aes_v1";
    private static final byte[] AAD = "miss-minutes-owner-registry-v1".getBytes(StandardCharsets.UTF_8);

    private OwnerRegistryStore() {}

    static JSONObject empty() throws Exception {
        return new JSONObject().put("version", 1).put("devices", new JSONArray());
    }

    /**
     * Validate the entire sealed registry before Rust is populated from any part of it. In
     * particular, the current device must already be present with the same key and be unrevoked;
     * silently re-adding a missing current entry would undo a lost/corrupt revocation registry.
     */
    static void validateForRestore(JSONObject record, String ownerId, String deviceId,
            byte[] currentPublicKey) throws Exception {
        if (record == null || ownerId == null || !ownerId.matches("[A-Za-z0-9_-]{16,64}")
                || !ownerId.equals(record.optString("ownerId", ""))
                || record.optInt("version", -1) != 1) {
            throw new SecurityException("Owner registry identity or version does not match this device.");
        }
        JSONArray devices = record.optJSONArray("devices");
        if (devices == null || devices.length() == 0 || devices.length() > 16) {
            throw new SecurityException("Owner registry has an invalid trusted-device list.");
        }
        Set<String> ids = new HashSet<>();
        Set<String> keys = new HashSet<>();
        int currentMatches = 0;
        for (int i = 0; i < devices.length(); i++) {
            JSONObject entry = devices.optJSONObject(i);
            if (entry == null) throw new SecurityException("Owner registry contains an invalid device record.");
            String id = entry.optString("deviceId", "");
            String platform = entry.optString("platform", "");
            Object revokedValue = entry.opt("revoked");
            if (!id.matches("[A-Za-z0-9_-]{16,64}")
                    || !("android".equals(platform) || "windows".equals(platform) || "linux".equals(platform))
                    || (revokedValue != null && !(revokedValue instanceof Boolean))
                    || !ids.add(id)) {
                throw new SecurityException("Owner registry contains a duplicate or malformed device record.");
            }
            byte[] key = Base64.getDecoder().decode(entry.getString("publicKey"));
            if (key.length != 65 || key[0] != 4 || !keys.add(Base64.getEncoder().encodeToString(key))) {
                throw new SecurityException("Owner registry contains an invalid or reused device key.");
            }
            if (deviceId.equals(id)) {
                currentMatches++;
                if (!"android".equals(platform) || entry.optBoolean("revoked", false)
                        || currentPublicKey == null || !MessageDigest.isEqual(key, currentPublicKey)) {
                    throw new SecurityException("This Android device is revoked or its enrolled key does not match.");
                }
            }
        }
        if (currentMatches != 1) throw new SecurityException("This Android device is not present in the trusted registry.");
        String recovery = record.optString("recoveryPublicKey", "");
        if (!recovery.isEmpty()) {
            byte[] recoveryKey = Base64.getDecoder().decode(recovery);
            if (recoveryKey.length != 65 || recoveryKey[0] != 4) {
                throw new SecurityException("Owner registry recovery credential is malformed.");
            }
        }
    }

    static JSONObject load(Context context) throws Exception {
        String encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(RECORD, null);
        if (encoded == null) return empty();
        byte[] blob = Base64.getDecoder().decode(encoded);
        if (blob.length < 12 + 16 || blob.length > 64 * 1024) throw new IllegalStateException("Owner registry has an invalid size.");
        byte[] nonce = java.util.Arrays.copyOfRange(blob, 0, 12);
        byte[] ciphertext = java.util.Arrays.copyOfRange(blob, 12, blob.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(AAD);
        JSONObject record = new JSONObject(new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
        if (record.optInt("version", -1) != 1 || record.optJSONArray("devices") == null)
            throw new IllegalStateException("Owner registry format is unsupported.");
        return record;
    }

    static void save(Context context, JSONObject record) throws Exception {
        if (record == null || record.optInt("version", -1) != 1 || record.optJSONArray("devices") == null)
            throw new IllegalArgumentException("Owner registry record is invalid.");
        byte[] plaintext = record.toString().getBytes(StandardCharsets.UTF_8);
        if (plaintext.length > 48 * 1024) throw new IllegalArgumentException("Owner registry is too large.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(AAD);
        byte[] nonce = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(plaintext);
        byte[] blob = new byte[nonce.length + ciphertext.length];
        System.arraycopy(nonce, 0, blob, 0, nonce.length);
        System.arraycopy(ciphertext, 0, blob, nonce.length, ciphertext.length);
        boolean saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(RECORD, Base64.getEncoder().encodeToString(blob)).commit();
        if (!saved) throw new IllegalStateException("Could not commit the protected owner registry.");
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
