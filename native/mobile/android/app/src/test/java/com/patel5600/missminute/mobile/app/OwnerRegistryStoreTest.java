package com.patel5600.missminute.mobile.app;

import static org.junit.Assert.assertThrows;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Base64;

public final class OwnerRegistryStoreTest {
    private static final String OWNER = "owner_identity_0001";
    private static final String DEVICE = "android_device_0001";

    private static byte[] key(int marker) {
        byte[] key = new byte[65];
        key[0] = 4;
        key[1] = (byte) marker;
        key[33] = 1;
        return key;
    }

    private static JSONObject registry(byte[] currentKey, boolean revoked) throws Exception {
        JSONObject current = new JSONObject().put("deviceId", DEVICE).put("platform", "android")
                .put("publicKey", Base64.getEncoder().encodeToString(currentKey)).put("revoked", revoked);
        return new JSONObject().put("version", 1).put("ownerId", OWNER)
                .put("devices", new JSONArray().put(current));
    }

    @Test public void validCurrentDeviceMustBePresentWithItsExactKey() throws Exception {
        OwnerRegistryStore.validateForRestore(registry(key(2), false), OWNER, DEVICE, key(2));
    }

    @Test public void missingCurrentDeviceCannotBeSilentlyReenrolled() throws Exception {
        JSONObject empty = new JSONObject().put("version", 1).put("ownerId", OWNER).put("devices", new JSONArray());
        assertThrows(SecurityException.class,
                () -> OwnerRegistryStore.validateForRestore(empty, OWNER, DEVICE, key(2)));
    }

    @Test public void revokedCurrentDeviceCannotBeRestoredOrAuthenticated() throws Exception {
        assertThrows(SecurityException.class,
                () -> OwnerRegistryStore.validateForRestore(registry(key(2), true), OWNER, DEVICE, key(2)));
    }

    @Test public void registryCannotSubstituteAnotherKeyForCurrentDevice() throws Exception {
        assertThrows(SecurityException.class,
                () -> OwnerRegistryStore.validateForRestore(registry(key(3), false), OWNER, DEVICE, key(2)));
    }

    @Test public void registryCannotBeReplayedAcrossOwnerIdentities() throws Exception {
        assertThrows(SecurityException.class,
                () -> OwnerRegistryStore.validateForRestore(registry(key(2), false), "other_owner_000001", DEVICE, key(2)));
    }

    @Test public void activityRecreationDoesNotResetTheAlreadyRestoredProcessAuthority() {
        org.junit.Assert.assertTrue(OwnerRestorePolicy.shouldRestore(false));
        org.junit.Assert.assertFalse(OwnerRestorePolicy.shouldRestore(true));
    }
}
