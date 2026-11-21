package com.patel5600.missminute.mobile.app;

import org.json.JSONObject;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.ECGenParameterSpec;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPublicKey;
import java.util.Arrays;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/** Portable passphrase-encrypted offline recovery key format; no private key is persisted in app storage. */
final class RecoveryMaterialCodec {
    private static final String TYPE = "miss-minutes-recovery-kit-v1";
    private static final int ITERATIONS = 600_000;
    private static final int SALT_BYTES = 16;
    private static final int NONCE_BYTES = 12;
    private static final int KEY_BITS = 256;
    private static final int MAX_MATERIAL_CHARS = 32 * 1024;
    private static final byte[] PUBLIC_KEY_PREFIX = new byte[] {
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, (byte) 0x86, 0x48, (byte) 0xce,
            0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, (byte) 0x86, 0x48, (byte) 0xce,
            0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
    };

    static final class Credential {
        final String ownerId;
        final byte[] publicKey;
        final PrivateKey privateKey;

        Credential(String ownerId, byte[] publicKey, PrivateKey privateKey) {
            this.ownerId = ownerId;
            this.publicKey = publicKey;
            this.privateKey = privateKey;
        }
    }

    private RecoveryMaterialCodec() { }

    static KeyPair generateKeyPair() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }

    static String create(String ownerId, KeyPair pair, char[] passphrase) throws Exception {
        validateOwnerAndPassphrase(ownerId, passphrase);
        byte[] publicKey = encodePublicKey((ECPublicKey) pair.getPublic());
        byte[] privateKey = pair.getPrivate().getEncoded();
        byte[] salt = new byte[SALT_BYTES];
        byte[] nonce = new byte[NONCE_BYTES];
        SecureRandom random = new SecureRandom();
        random.nextBytes(salt);
        random.nextBytes(nonce);
        byte[] derived = derive(passphrase, salt);
        byte[] encrypted;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(derived, "AES"), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(aad(ownerId, publicKey));
            encrypted = cipher.doFinal(privateKey);
        } finally {
            Arrays.fill(privateKey, (byte) 0);
            Arrays.fill(derived, (byte) 0);
        }
        return new JSONObject().put("type", TYPE).put("version", 1).put("ownerId", ownerId)
                .put("publicKey", Base64.getEncoder().encodeToString(publicKey))
                .put("salt", Base64.getEncoder().encodeToString(salt))
                .put("nonce", Base64.getEncoder().encodeToString(nonce))
                .put("iterations", ITERATIONS)
                .put("encryptedPrivateKey", Base64.getEncoder().encodeToString(encrypted)).toString();
    }

    static Credential open(String material, char[] passphrase) throws Exception {
        if (material == null || material.length() > MAX_MATERIAL_CHARS) throw new IllegalArgumentException("Recovery material is too large.");
        if (passphrase == null || passphrase.length < 12 || passphrase.length > 256 || !asciiPassphrase(passphrase))
            throw new IllegalArgumentException("Recovery passphrase must be 12 to 256 printable ASCII characters.");
        JSONObject json = new JSONObject(material);
        if (!TYPE.equals(json.optString("type")) || json.optInt("version", -1) != 1)
            throw new IllegalArgumentException("Unsupported recovery material format.");
        String ownerId = json.getString("ownerId");
        if (!ownerId.matches("[A-Za-z0-9_-]{16,64}")) throw new IllegalArgumentException("Recovery owner identity is invalid.");
        int iterations = json.optInt("iterations", -1);
        if (iterations != ITERATIONS) throw new IllegalArgumentException("Recovery key derivation parameters are unsupported.");
        byte[] publicKey = Base64.getDecoder().decode(json.getString("publicKey"));
        byte[] salt = Base64.getDecoder().decode(json.getString("salt"));
        byte[] nonce = Base64.getDecoder().decode(json.getString("nonce"));
        byte[] encrypted = Base64.getDecoder().decode(json.getString("encryptedPrivateKey"));
        if (publicKey.length != 65 || publicKey[0] != 4 || salt.length != SALT_BYTES
                || nonce.length != NONCE_BYTES || encrypted.length < 64 || encrypted.length > 4096)
            throw new IllegalArgumentException("Recovery material fields are invalid.");

        byte[] derived = derive(passphrase, salt);
        byte[] privateEncoded;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(derived, "AES"), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(aad(ownerId, publicKey));
            privateEncoded = cipher.doFinal(encrypted);
        } finally {
            Arrays.fill(derived, (byte) 0);
        }
        PrivateKey privateKey;
        try {
            privateKey = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(privateEncoded));
        } finally {
            Arrays.fill(privateEncoded, (byte) 0);
        }
        verifyKeyPair(ownerId, publicKey, privateKey);
        return new Credential(ownerId, publicKey, privateKey);
    }

    private static void verifyKeyPair(String ownerId, byte[] rawPublicKey, PrivateKey privateKey) throws Exception {
        PublicKey publicKey = KeyFactory.getInstance("EC").generatePublic(
                new java.security.spec.X509EncodedKeySpec(concat(PUBLIC_KEY_PREFIX, rawPublicKey)));
        byte[] proof = ("miss-minutes-recovery-key-check-v1\0" + ownerId).getBytes(StandardCharsets.UTF_8);
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(privateKey);
        signer.update(proof);
        byte[] signature = signer.sign();
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(publicKey);
        verifier.update(proof);
        if (!verifier.verify(signature)) throw new SecurityException("Recovery key pair does not match.");
        Arrays.fill(signature, (byte) 0);
    }

    private static byte[] derive(char[] passphrase, byte[] salt) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(passphrase, salt, ITERATIONS, KEY_BITS);
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } finally {
            spec.clearPassword();
        }
    }

    private static void validateOwnerAndPassphrase(String ownerId, char[] passphrase) {
        if (ownerId == null || !ownerId.matches("[A-Za-z0-9_-]{16,64}")) throw new IllegalArgumentException("Owner identity is invalid.");
        if (passphrase == null || passphrase.length < 12 || passphrase.length > 256
                || !asciiPassphrase(passphrase))
            throw new IllegalArgumentException("Recovery passphrase must be 12 to 256 printable ASCII characters so the same kit works across Android and desktop.");
    }

    private static boolean asciiPassphrase(char[] passphrase) {
        for (char value : passphrase) if (value < 0x20 || value > 0x7e) return false;
        return true;
    }

    private static byte[] aad(String ownerId, byte[] publicKey) {
        return (TYPE + "\n" + ownerId + "\n" + Base64.getEncoder().encodeToString(publicKey)).getBytes(StandardCharsets.UTF_8);
    }

    static byte[] encodePublicKey(ECPublicKey key) {
        byte[] x = fixed32(key.getW().getAffineX());
        byte[] y = fixed32(key.getW().getAffineY());
        byte[] out = new byte[65];
        out[0] = 4;
        System.arraycopy(x, 0, out, 1, x.length);
        System.arraycopy(y, 0, out, 33, y.length);
        return out;
    }

    private static byte[] fixed32(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[32];
        int copy = Math.min(raw.length, out.length);
        System.arraycopy(raw, raw.length - copy, out, out.length - copy, copy);
        return out;
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }
}
