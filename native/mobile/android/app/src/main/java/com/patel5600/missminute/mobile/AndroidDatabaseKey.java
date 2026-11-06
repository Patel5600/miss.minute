package com.patel5600.missminute.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.File;
import java.nio.ByteBuffer;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keeps the SQLCipher database key encrypted by a non-exportable Android
 * Keystore AES-256-GCM key. The wrapped key is stored in app-private
 * SharedPreferences; the raw SQLCipher key is never persisted there.
 */
final class AndroidDatabaseKey {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String WRAPPING_ALIAS = "com.patel5600.missminute.db-wrap.v1";
    private static final String PREFS_NAME = "miss_minutes_crypto";
    private static final String WRAPPED_KEY_PREF = "sqlcipher_key_wrap_v1";
    private static final int DATABASE_KEY_BYTES = 32;
    private static final int GCM_NONCE_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    private AndroidDatabaseKey() {}

    static String databasePassword(Context context, File databaseFile) throws Exception {
        SharedPreferences preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String wrapped = preferences.getString(WRAPPED_KEY_PREF, null);
        byte[] rawKey;

        if (wrapped != null) {
            rawKey = unwrap(preferences, wrapped);
        } else {
            // Do not open a pre-existing plaintext database with a new key.
            // A key mismatch must never look like an empty history.
            if (databaseFile.isFile() && databaseFile.length() > 0) {
                throw new IllegalStateException(
                    "An existing metadata database has no Android Keystore key envelope. " +
                    "It was not opened or replaced. Export or remove the legacy development database explicitly."
                );
            }
            rawKey = new byte[DATABASE_KEY_BYTES];
            new SecureRandom().nextBytes(rawKey);
            try {
                String envelope = wrap(rawKey);
                if (!preferences.edit().putString(WRAPPED_KEY_PREF, envelope).commit()) {
                    throw new IllegalStateException("Could not durably save the wrapped database key.");
                }
            } catch (Exception error) {
                Arrays.fill(rawKey, (byte) 0);
                throw error;
            }
        }

        if (rawKey.length != DATABASE_KEY_BYTES) {
            Arrays.fill(rawKey, (byte) 0);
            throw new IllegalStateException("Stored SQLCipher key has an invalid length.");
        }
        try {
            return toHex(rawKey);
        } finally {
            Arrays.fill(rawKey, (byte) 0);
        }
    }

    private static String wrap(byte[] rawKey) throws Exception {
        SecretKey master = getOrCreateWrappingKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, master);
        byte[] nonce = cipher.getIV();
        if (nonce == null || nonce.length != GCM_NONCE_BYTES) {
            throw new IllegalStateException("Android Keystore returned an invalid AES-GCM nonce.");
        }
        byte[] ciphertext = cipher.doFinal(rawKey);
        ByteBuffer envelope = ByteBuffer.allocate(nonce.length + ciphertext.length);
        envelope.put(nonce).put(ciphertext);
        return Base64.encodeToString(envelope.array(), Base64.NO_WRAP);
    }

    private static byte[] unwrap(SharedPreferences preferences, String wrapped) throws Exception {
        SecretKey master = getExistingWrappingKey();
        byte[] envelope = Base64.decode(wrapped, Base64.NO_WRAP);
        if (envelope.length != GCM_NONCE_BYTES + DATABASE_KEY_BYTES + (GCM_TAG_BITS / 8)) {
            throw new IllegalStateException("Stored database-key envelope has an invalid length.");
        }
        byte[] nonce = Arrays.copyOfRange(envelope, 0, GCM_NONCE_BYTES);
        byte[] ciphertext = Arrays.copyOfRange(envelope, GCM_NONCE_BYTES, envelope.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, master, new GCMParameterSpec(GCM_TAG_BITS, nonce));
        byte[] result = cipher.doFinal(ciphertext);
        Arrays.fill(envelope, (byte) 0);
        Arrays.fill(ciphertext, (byte) 0);
        return result;
    }

    private static SecretKey getExistingWrappingKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        if (!keyStore.containsAlias(WRAPPING_ALIAS)) {
            throw new IllegalStateException(
                "Android Keystore database-wrapping key is missing. Refusing to generate a replacement."
            );
        }
        return (SecretKey) keyStore.getKey(WRAPPING_ALIAS, null);
    }

    private static SecretKey getOrCreateWrappingKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        if (keyStore.containsAlias(WRAPPING_ALIAS)) {
            return (SecretKey) keyStore.getKey(WRAPPING_ALIAS, null);
        }

        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER
        );
        KeyGenParameterSpec specification = new KeyGenParameterSpec.Builder(
            WRAPPING_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build();
        generator.init(specification);
        return generator.generateKey();
    }

    private static String toHex(byte[] bytes) {
        char[] alphabet = "0123456789abcdef".toCharArray();
        char[] encoded = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xff;
            encoded[i * 2] = alphabet[value >>> 4];
            encoded[i * 2 + 1] = alphabet[value & 0x0f];
        }
        return new String(encoded);
    }
}
