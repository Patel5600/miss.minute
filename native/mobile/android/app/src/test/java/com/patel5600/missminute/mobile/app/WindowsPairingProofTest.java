package com.patel5600.missminute.mobile.app;

import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;

public final class WindowsPairingProofTest {
    private static final byte[] CREDENTIAL_ID = new byte[] { 3, 1, 4, 1, 5, 9 };

    @Test public void acceptsUserVerifiedAssertionBoundToMissMinutesPairingChallenge() throws Exception {
        KeyPair pair = keyPair();
        byte[] challenge = "pairing challenge".getBytes(StandardCharsets.UTF_8);
        WindowsWebAuthnProof.verify(rawPublic(pair), CREDENTIAL_ID, challenge, proof(pair, challenge, true));
    }

    @Test public void rejectsWrongChallengeOriginRpIdCredentialAndMissingUserVerification() throws Exception {
        KeyPair pair = keyPair();
        byte[] challenge = "pairing challenge".getBytes(StandardCharsets.UTF_8);
        assertThrows(SecurityException.class, () -> WindowsWebAuthnProof.verify(
                rawPublic(pair), CREDENTIAL_ID, "other challenge".getBytes(StandardCharsets.UTF_8), proof(pair, challenge, true)));
        assertThrows(SecurityException.class, () -> WindowsWebAuthnProof.verify(
                rawPublic(pair), CREDENTIAL_ID, challenge, proof(pair, challenge, false)));
        assertThrows(SecurityException.class, () -> WindowsWebAuthnProof.verify(
                rawPublic(keyPair()), CREDENTIAL_ID, challenge, proof(pair, challenge, true)));
        JSONObject wrongOrigin = proof(pair, challenge, true);
        JSONObject client = new JSONObject(new String(decode(wrongOrigin.getString("clientDataJson")), StandardCharsets.UTF_8));
        client.put("origin", "https://attacker.invalid");
        wrongOrigin.put("clientDataJson", url(client.toString().getBytes(StandardCharsets.UTF_8)));
        assertThrows(SecurityException.class, () -> WindowsWebAuthnProof.verify(
                rawPublic(pair), CREDENTIAL_ID, challenge, wrongOrigin));
    }

    private static JSONObject proof(KeyPair key, byte[] challenge, boolean verified) throws Exception {
        byte[] challengeB64 = Base64.getUrlEncoder().withoutPadding().encode(challenge);
        byte[] clientData = new JSONObject().put("type", "webauthn.get")
                .put("challenge", new String(challengeB64, StandardCharsets.US_ASCII))
                .put("origin", "https://missminutes.local").put("crossOrigin", false)
                .toString().getBytes(StandardCharsets.UTF_8);
        byte[] authData = new byte[37];
        System.arraycopy(MessageDigest.getInstance("SHA-256").digest("missminutes.local".getBytes(StandardCharsets.UTF_8)), 0, authData, 0, 32);
        authData[32] = (byte) (verified ? 0x05 : 0x01);
        byte[] clientHash = MessageDigest.getInstance("SHA-256").digest(clientData);
        byte[] signed = ByteBuffer.allocate(authData.length + clientHash.length).put(authData).put(clientHash).array();
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(key.getPrivate());
        signer.update(signed);
        return new JSONObject().put("credentialId", url(CREDENTIAL_ID)).put("authenticatorData", url(authData))
                .put("signature", url(signer.sign())).put("clientDataJson", url(clientData));
    }

    private static KeyPair keyPair() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }

    private static byte[] rawPublic(KeyPair pair) {
        ECPublicKey key = (ECPublicKey) pair.getPublic();
        byte[] raw = new byte[65]; raw[0] = 4;
        byte[] x = fixed(key.getW().getAffineX().toByteArray());
        byte[] y = fixed(key.getW().getAffineY().toByteArray());
        System.arraycopy(x, 0, raw, 1, 32); System.arraycopy(y, 0, raw, 33, 32);
        return raw;
    }

    private static byte[] fixed(byte[] value) {
        byte[] output = new byte[32];
        int count = Math.min(value.length, 32);
        System.arraycopy(value, value.length - count, output, 32 - count, count);
        return output;
    }

    private static String url(byte[] value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value); }
    private static byte[] decode(String value) { return Base64.getUrlDecoder().decode(value); }
}
