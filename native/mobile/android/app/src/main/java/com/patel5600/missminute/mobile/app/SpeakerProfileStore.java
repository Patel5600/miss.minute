package com.patel5600.missminute.mobile.app;

import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores one device-local speaker template encrypted by an Android Keystore key. */
final class SpeakerProfileStore {
    private static final String PREFS = "owner_speaker_profile";
    private static final String RECORD = "wespeaker_voxceleb_resnet34_v1";
    private static final String PENDING_RECORD = "wespeaker_voxceleb_resnet34_pending_v1";
    private static final String KEY_ALIAS = "miss_minutes_speaker_profile_aes_v1";
    private static final byte[] AAD = (RECORD + "/model=wespeaker_en_voxceleb_resnet34.onnx")
            .getBytes(StandardCharsets.UTF_8);

    private SpeakerProfileStore() {}

    static boolean exists(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(RECORD);
    }

    static boolean existsPending(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(PENDING_RECORD);
    }

    static void save(Context context, float[] embedding) throws Exception {
        save(context, embedding, RECORD);
    }

    static void savePending(Context context, float[] embedding) throws Exception {
        save(context, embedding, PENDING_RECORD);
    }

    private static void save(Context context, float[] embedding, String record) throws Exception {
        validate(embedding);
        ByteBuffer plain = ByteBuffer.allocate(8 + embedding.length * Float.BYTES).order(ByteOrder.LITTLE_ENDIAN);
        plain.putInt(1);
        plain.putInt(embedding.length);
        for (float value : embedding) plain.putFloat(value);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(AAD);
        byte[] encrypted = cipher.doFinal(plain.array());
        byte[] blob = new byte[cipher.getIV().length + encrypted.length];
        System.arraycopy(cipher.getIV(), 0, blob, 0, cipher.getIV().length);
        System.arraycopy(encrypted, 0, blob, cipher.getIV().length, encrypted.length);
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(record, Base64.getEncoder().encodeToString(blob)).commit()) {
            throw new IllegalStateException("Could not save the encrypted local speaker profile.");
        }
    }

    static void activatePending(Context context) {
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String pending = prefs.getString(PENDING_RECORD, null);
        if (pending != null && !prefs.edit().putString(RECORD, pending).remove(PENDING_RECORD).commit())
            throw new IllegalStateException("Could not activate the verified owner's speaker profile.");
    }

    static float[] load(Context context, int expectedDimensions) throws Exception {
        String encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(RECORD, null);
        if (encoded == null) return null;
        byte[] blob = Base64.getDecoder().decode(encoded);
        if (blob.length < 12 + 16 + 8) throw new IllegalStateException("Stored speaker profile is malformed.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(blob, 0, 12)));
        cipher.updateAAD(AAD);
        byte[] clear = cipher.doFinal(blob, 12, blob.length - 12);
        ByteBuffer plain = ByteBuffer.wrap(clear).order(ByteOrder.LITTLE_ENDIAN);
        if (plain.getInt() != 1) throw new IllegalStateException("Stored speaker profile version is unsupported.");
        int dimensions = plain.getInt();
        if (dimensions != expectedDimensions || clear.length != 8 + dimensions * Float.BYTES)
            throw new IllegalStateException("Stored speaker profile does not match the installed model.");
        float[] embedding = new float[dimensions];
        for (int i = 0; i < dimensions; i++) embedding[i] = plain.getFloat();
        validate(embedding);
        return embedding;
    }

    static void delete(Context context) throws Exception {
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(RECORD).remove(PENDING_RECORD).commit())
            throw new IllegalStateException("Could not delete the local speaker profile.");
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setUnlockedDeviceRequired(true);
        generator.init(spec.build());
        return generator.generateKey();
    }

    private static void validate(float[] values) {
        if (values == null || values.length < 16 || values.length > 4096)
            throw new IllegalArgumentException("Speaker embedding dimensions are invalid.");
        double norm = 0;
        for (float value : values) {
            if (!Float.isFinite(value)) throw new IllegalArgumentException("Speaker embedding contains an invalid value.");
            norm += value * value;
        }
        if (norm < 0.5 || norm > 1.5)
            throw new IllegalArgumentException("Speaker embedding failed its normalization check.");
    }
}
