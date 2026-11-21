package com.patel5600.missminute.mobile.core.security;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.Signature;

import org.junit.Test;

public final class OwnerAuthProofTest {
    private static KeyPair newKeyPair() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(256);
        return generator.generateKeyPair();
    }

    private static byte[] sign(KeyPair pair, byte[] challenge) throws Exception {
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(pair.getPrivate());
        signer.update(challenge);
        return signer.sign();
    }

    @Test
    public void verifiesSignatureForTheExactChallenge() throws Exception {
        KeyPair pair = newKeyPair();
        OwnerAuthProof.Challenge challenge = OwnerAuthProof.create(
                "permissions.setMode", "AUTHORIZED", 1234L, new SecureRandom());

        byte[] signature = sign(pair, challenge.encoded());

        assertTrue(OwnerAuthProof.verify(pair.getPublic(), challenge.encoded(), signature));
    }

    @Test
    public void rejectsSignatureForDifferentOperation() throws Exception {
        KeyPair pair = newKeyPair();
        OwnerAuthProof.Challenge authorize = OwnerAuthProof.create(
                "permissions.setMode", "AUTHORIZED", 1234L, new SecureRandom());
        OwnerAuthProof.Challenge lowerMode = OwnerAuthProof.create(
                "permissions.setMode", "OBSERVE", 1234L, new SecureRandom());

        byte[] signature = sign(pair, authorize.encoded());

        assertFalse(OwnerAuthProof.verify(pair.getPublic(), lowerMode.encoded(), signature));
    }

    @Test
    public void rejectsSignatureFromDifferentKey() throws Exception {
        KeyPair authorizedKey = newKeyPair();
        KeyPair attackerKey = newKeyPair();
        OwnerAuthProof.Challenge challenge = OwnerAuthProof.create(
                "permissions.setMode", "SUGGEST", 4567L, new SecureRandom());

        byte[] signature = sign(attackerKey, challenge.encoded());

        assertFalse(OwnerAuthProof.verify(authorizedKey.getPublic(), challenge.encoded(), signature));
    }

    @Test
    public void rejectsModifiedChallengeAndMalformedSignatures() throws Exception {
        KeyPair pair = newKeyPair();
        OwnerAuthProof.Challenge challenge = OwnerAuthProof.create(
                "permissions.setMode", "AUTHORIZED", 9876L, new SecureRandom());
        byte[] signed = sign(pair, challenge.encoded());
        byte[] changed = challenge.encoded();
        changed[changed.length - 1] ^= 0x01;

        assertFalse(OwnerAuthProof.verify(pair.getPublic(), changed, signed));
        assertFalse(OwnerAuthProof.verify(pair.getPublic(), challenge.encoded(), new byte[] {1, 2, 3}));
        assertFalse(OwnerAuthProof.verify(null, challenge.encoded(), signed));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsUnboundedOrAmbiguousChallengeFields() {
        OwnerAuthProof.create("permissions.setMode\n", "AUTHORIZED", 1L, new SecureRandom());
    }

    @Test
    public void challengeHasUniqueNonceAndCorrelationIdentifier() {
        SecureRandom random = new SecureRandom();
        OwnerAuthProof.Challenge first = OwnerAuthProof.create(
                "permissions.setMode", "AUTHORIZED", 1234L, random);
        OwnerAuthProof.Challenge second = OwnerAuthProof.create(
                "permissions.setMode", "AUTHORIZED", 1234L, random);

        assertFalse(java.util.Arrays.equals(first.encoded(), second.encoded()));
        assertFalse(first.auditId().equals(second.auditId()));
    }
}
