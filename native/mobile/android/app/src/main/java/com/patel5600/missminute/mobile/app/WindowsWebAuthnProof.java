package com.patel5600.missminute.mobile.app;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;

/** Verifies Windows Hello WebAuthn assertions received through the offline device-pairing flow. */
final class WindowsWebAuthnProof {
    private static final String RP_ID = "missminutes.local";
    private static final String ORIGIN = "https://missminutes.local";

    private WindowsWebAuthnProof() { }

    static void verify(byte[] sourceKey, byte[] expectedCredentialId, byte[] challenge, JSONObject proof) throws Exception {
        if (sourceKey == null || sourceKey.length != 65 || sourceKey[0] != 4
                || expectedCredentialId == null || expectedCredentialId.length == 0 || expectedCredentialId.length > 2048
                || challenge == null || challenge.length == 0 || challenge.length > 4096)
            throw new SecurityException("The Windows credential identity or pairing challenge is invalid.");
        byte[] credentialId = decodeUrlBase64Bounded(proof.getString("credentialId"), 2048);
        byte[] authenticatorData = decodeUrlBase64Bounded(proof.getString("authenticatorData"), 16 * 1024);
        byte[] signature = decodeUrlBase64Bounded(proof.getString("signature"), 4096);
        byte[] clientDataJson = decodeUrlBase64Bounded(proof.getString("clientDataJson"), 4096);
        if (!MessageDigest.isEqual(credentialId, expectedCredentialId) || authenticatorData.length < 37)
            throw new SecurityException("Windows Hello assertion credential did not match the trusted device.");
        byte[] expectedRpHash = MessageDigest.getInstance("SHA-256").digest(RP_ID.getBytes(StandardCharsets.UTF_8));
        if (!MessageDigest.isEqual(expectedRpHash, Arrays.copyOfRange(authenticatorData, 0, 32))
                || (authenticatorData[32] & 0x05) != 0x05)
            throw new SecurityException("Windows Hello did not verify the Miss Minutes pairing challenge.");
        JSONObject clientData = new JSONObject(new String(clientDataJson, StandardCharsets.UTF_8));
        String expectedChallenge = Base64.getUrlEncoder().withoutPadding().encodeToString(challenge);
        if (!"webauthn.get".equals(clientData.optString("type"))
                || !expectedChallenge.equals(clientData.optString("challenge"))
                || !ORIGIN.equals(clientData.optString("origin"))
                || clientData.optBoolean("crossOrigin", false))
            throw new SecurityException("Windows Hello assertion is bound to a different pairing request.");
        byte[] clientHash = MessageDigest.getInstance("SHA-256").digest(clientDataJson);
        byte[] signed = new byte[authenticatorData.length + clientHash.length];
        System.arraycopy(authenticatorData, 0, signed, 0, authenticatorData.length);
        System.arraycopy(clientHash, 0, signed, authenticatorData.length, clientHash.length);
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(decodeP256PublicKey(sourceKey));
        verifier.update(signed);
        if (!verifier.verify(signature)) throw new SecurityException("Windows Hello pairing signature is invalid.");
    }

    private static byte[] decodeUrlBase64Bounded(String value, int maxBytes) {
        if (value == null || value.length() > maxBytes * 2) throw new IllegalArgumentException("WebAuthn proof field exceeds its limit.");
        byte[] decoded = Base64.getUrlDecoder().decode(value);
        if (decoded.length == 0 || decoded.length > maxBytes) throw new IllegalArgumentException("WebAuthn proof field has an invalid size.");
        return decoded;
    }

    private static java.security.PublicKey decodeP256PublicKey(byte[] raw) throws Exception {
        byte[] prefix = new byte[] {0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, (byte)0x86, 0x48, (byte)0xce,
                0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, (byte)0x86, 0x48, (byte)0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00};
        byte[] encoded = new byte[prefix.length + raw.length];
        System.arraycopy(prefix, 0, encoded, 0, prefix.length);
        System.arraycopy(raw, 0, encoded, prefix.length, raw.length);
        return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(encoded));
    }
}
