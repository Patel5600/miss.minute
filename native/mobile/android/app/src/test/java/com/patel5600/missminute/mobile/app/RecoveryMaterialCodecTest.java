package com.patel5600.missminute.mobile.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Base64;

public final class RecoveryMaterialCodecTest {
    private static final String OWNER_ID = "owner-0123456789abcdef";
    private static final char[] PASSPHRASE = "correct horse battery staple".toCharArray();

    @Test public void recoveryMaterialRoundTripsOnlyWithPassphraseAndMatchingOwner() throws Exception {
        java.security.KeyPair pair = RecoveryMaterialCodec.generateKeyPair();
        String material = RecoveryMaterialCodec.create(OWNER_ID, pair, PASSPHRASE);
        RecoveryMaterialCodec.Credential recovered = RecoveryMaterialCodec.open(material, PASSPHRASE);
        assertTrue(material.contains("miss-minutes-recovery-kit-v1"));
        assertFalse(material.contains("correct horse"));
        assertTrue(recovered.ownerId.equals(OWNER_ID));
        assertArrayEquals(encode(pair), recovered.publicKey);
        assertThrows(Exception.class, () -> RecoveryMaterialCodec.open(material, "wrong passphrase".toCharArray()));
    }

    @Test public void recoveryMaterialAuthenticationBindsOwnerAndPublicKey() throws Exception {
        String material = RecoveryMaterialCodec.create(OWNER_ID, RecoveryMaterialCodec.generateKeyPair(), PASSPHRASE);
        org.json.JSONObject changedOwner = new org.json.JSONObject(material).put("ownerId", "owner-abcdef0123456789");
        assertThrows(Exception.class, () -> RecoveryMaterialCodec.open(changedOwner.toString(), PASSPHRASE));
        org.json.JSONObject changedKey = new org.json.JSONObject(material).put("publicKey",
                Base64.getEncoder().encodeToString(new byte[65]));
        assertThrows(Exception.class, () -> RecoveryMaterialCodec.open(changedKey.toString(), PASSPHRASE));
    }

    @Test public void recoveryMaterialRejectsWeakPassphrasesAndOversizedInput() throws Exception {
        java.security.KeyPair pair = RecoveryMaterialCodec.generateKeyPair();
        assertThrows(IllegalArgumentException.class, () -> RecoveryMaterialCodec.create(OWNER_ID, pair, "short".toCharArray()));
        assertThrows(IllegalArgumentException.class, () -> RecoveryMaterialCodec.create(OWNER_ID, pair, "påssphrase-strong".toCharArray()));
        String validKit = RecoveryMaterialCodec.create(OWNER_ID, pair, PASSPHRASE);
        assertThrows(IllegalArgumentException.class, () -> RecoveryMaterialCodec.open(validKit, "påssphrase-strong".toCharArray()));
        assertThrows(IllegalArgumentException.class, () -> RecoveryMaterialCodec.open("x".repeat(33 * 1024), PASSPHRASE));
    }

    private static byte[] encode(java.security.KeyPair pair) {
        java.security.interfaces.ECPublicKey key = (java.security.interfaces.ECPublicKey) pair.getPublic();
        java.math.BigInteger x = key.getW().getAffineX();
        java.math.BigInteger y = key.getW().getAffineY();
        byte[] out = new byte[65];
        out[0] = 4;
        fixed32(x, out, 1);
        fixed32(y, out, 33);
        return out;
    }

    private static void fixed32(java.math.BigInteger value, byte[] out, int offset) {
        byte[] raw = value.toByteArray();
        int length = Math.min(32, raw.length);
        System.arraycopy(raw, raw.length - length, out, offset + 32 - length, length);
    }
}
