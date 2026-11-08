package com.patel5600.missminute.mobile.core.security;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.SecureRandom;

/**
 * Canonical, operation-bound challenge format for owner authentication.
 *
 * The caller must obtain the signature from an authentication-gated Keystore key.
 * This class deliberately does not decide authorization policy or persist sessions.
 */
public final class OwnerAuthProof {
    private static final byte[] DOMAIN =
            "com.patel5600.missminute.owner-auth.v1".getBytes(StandardCharsets.US_ASCII);
    private static final int NONCE_BYTES = 32;
    private static final int MAX_FIELD_BYTES = 96;

    private OwnerAuthProof() {}

    public static Challenge create(String action, String target, long issuedAtElapsedMs,
                                   SecureRandom random) {
        byte[] actionBytes = field(action, "action");
        byte[] targetBytes = field(target, "target");
        if (issuedAtElapsedMs < 0 || random == null) {
            throw new IllegalArgumentException("invalid challenge metadata");
        }
        byte[] nonce = new byte[NONCE_BYTES];
        random.nextBytes(nonce);
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            DataOutputStream out = new DataOutputStream(bytes);
            out.writeInt(DOMAIN.length);
            out.write(DOMAIN);
            out.writeInt(actionBytes.length);
            out.write(actionBytes);
            out.writeInt(targetBytes.length);
            out.write(targetBytes);
            out.writeLong(issuedAtElapsedMs);
            out.writeInt(nonce.length);
            out.write(nonce);
            out.flush();
            byte[] encoded = bytes.toByteArray();
            return new Challenge(encoded, sha256(encoded), issuedAtElapsedMs);
        } catch (IOException impossible) {
            throw new IllegalStateException("in-memory challenge encoding failed", impossible);
        } finally {
            java.util.Arrays.fill(nonce, (byte) 0);
        }
    }

    private static byte[] field(String value, String label) {
        if (value == null || value.isEmpty() || value.length() > MAX_FIELD_BYTES) {
            throw new IllegalArgumentException("invalid " + label);
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == ':' || c == '-';
            if (!allowed) {
                throw new IllegalArgumentException("invalid " + label);
            }
        }
        return value.getBytes(StandardCharsets.US_ASCII);
    }

    public static boolean verify(PublicKey key, byte[] challenge, byte[] signedChallenge) {
        if (key == null || challenge == null || signedChallenge == null
                || challenge.length == 0 || challenge.length > 512
                || signedChallenge.length == 0 || signedChallenge.length > 256) {
            return false;
        }
        try {
            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(key);
            verifier.update(challenge);
            return verifier.verify(signedChallenge);
        } catch (GeneralSecurityException error) {
            return false;
        }
    }

    private static byte[] sha256(byte[] value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value);
        } catch (GeneralSecurityException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    public static final class Challenge {
        private final byte[] encoded;
        private final byte[] digest;
        public final long issuedAtElapsedMs;

        private Challenge(byte[] encoded, byte[] digest, long issuedAtElapsedMs) {
            this.encoded = encoded.clone();
            this.digest = digest.clone();
            this.issuedAtElapsedMs = issuedAtElapsedMs;
        }

        public byte[] encoded() { return encoded.clone(); }

        /** Short, non-secret correlation identifier for the audit log. */
        public String auditId() {
            StringBuilder out = new StringBuilder(24);
            for (int i = 0; i < 12; i++) {
                out.append(String.format(java.util.Locale.ROOT, "%02x", digest[i] & 0xff));
            }
            return out.toString();
        }
    }
}
