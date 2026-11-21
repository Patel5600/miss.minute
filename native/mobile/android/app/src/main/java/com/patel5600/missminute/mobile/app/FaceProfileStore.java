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

/** Device-local encrypted SFace embedding. It never stores or synchronizes a camera frame. */
final class FaceProfileStore {
    private static final String PREFS = "owner_face_profile";
    private static final String RECORD = "sface_template_v1";
    private static final String PENDING_RECORD = "sface_template_pending_v1";
    private static final String KEY_ALIAS = "miss_minutes_face_profile_aes_v1";
    private static final byte[] AAD = "miss-minutes-face-template-v1".getBytes(StandardCharsets.UTF_8);
    private static final int DIMENSIONS = 128;

    private FaceProfileStore() {}

    static boolean exists(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(RECORD);
    }

    static boolean existsPending(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(PENDING_RECORD);
    }

    static void save(Context context, float[] template) throws Exception {
        save(context, template, RECORD);
    }

    static void savePending(Context context, float[] template) throws Exception {
        save(context, template, PENDING_RECORD);
    }

    private static void save(Context context, float[] template, String record) throws Exception {
        validate(template);
        ByteBuffer plain = ByteBuffer.allocate(4 + DIMENSIONS * 4).order(ByteOrder.LITTLE_ENDIAN);
        plain.putInt(1);
        for (float value : template) plain.putFloat(value);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(AAD);
        byte[] nonce = cipher.getIV();
        byte[] encrypted = cipher.doFinal(plain.array());
        byte[] blob = new byte[nonce.length + encrypted.length];
        System.arraycopy(nonce, 0, blob, 0, nonce.length);
        System.arraycopy(encrypted, 0, blob, nonce.length, encrypted.length);
        boolean saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(record, Base64.getEncoder().encodeToString(blob)).commit();
        if (!saved) throw new IllegalStateException("Could not commit the encrypted face profile.");
    }

    static void activatePending(Context context) {
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String pending = prefs.getString(PENDING_RECORD, null);
        if (pending != null && !prefs.edit().putString(RECORD, pending).remove(PENDING_RECORD).commit())
            throw new IllegalStateException("Could not activate the verified owner's face profile.");
    }

    static float[] load(Context context) throws Exception {
        String encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(RECORD, null);
        if (encoded == null) return null;
        byte[] blob = Base64.getDecoder().decode(encoded);
        if (blob.length != 12 + 16 + 4 + DIMENSIONS * 4)
            throw new IllegalStateException("Stored face profile has an invalid size.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(blob, 0, 12)));
        cipher.updateAAD(AAD);
        byte[] bytes = cipher.doFinal(blob, 12, blob.length - 12);
        ByteBuffer plain = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        if (plain.getInt() != 1) throw new IllegalStateException("Stored face profile version is unsupported.");
        float[] template = new float[DIMENSIONS];
        for (int i = 0; i < DIMENSIONS; i++) template[i] = plain.getFloat();
        validate(template);
        return template;
    }

    static void delete(Context context) throws Exception {
        boolean removed = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(RECORD).remove(PENDING_RECORD).commit();
        if (!removed) throw new IllegalStateException("Could not delete the local face profile.");
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
        if (values == null || values.length != DIMENSIONS)
            throw new IllegalArgumentException("SFace must produce a 128-value template.");
        double norm = 0;
        for (float value : values) {
            if (!Float.isFinite(value)) throw new IllegalArgumentException("Face template is not finite.");
            norm += value * value;
        }
        if (norm < 0.5 || norm > 1.5)
            throw new IllegalArgumentException("Face template failed the embedding norm check.");
    }
}
