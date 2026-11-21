package com.patel5600.missminute.mobile.bridge.handlers;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.core.protocol.Role;

import org.junit.Test;

public final class OwnerDataHandlersTest {
    @Test public void onlyTheIsolatedMigrationImportMayCarryLegacyProviderCredentials() {
        assertTrue(OwnerDataHandlers.allowProviderSecretMigration(Role.MIGRATION, "importBatch", "kv"));
        assertFalse(OwnerDataHandlers.allowProviderSecretMigration(Role.DASHBOARD, "importBatch", "kv"));
        assertFalse(OwnerDataHandlers.allowProviderSecretMigration(Role.MIGRATION, "list", "kv"));
        assertFalse(OwnerDataHandlers.allowProviderSecretMigration(Role.MIGRATION, "importBatch", "messages"));
    }

    @Test public void migrationStoreCapabilitiesStayBoundToTheSessionThatStartedTheImport() {
        final String[] activeSession = { "session-A" };
        final String[] checkedSession = { null };
        OwnerDataHandlers.CapabilityAuthorizer authorizer = OwnerDataHandlers.bindSession("session-A",
                (sessionId, capability) -> {
                    checkedSession[0] = sessionId;
                    return sessionId.equals(activeSession[0]) && "memory.private.write".equals(capability);
                });

        assertTrue(authorizer.authorize("memory.private.write"));
        assertEquals("session-A", checkedSession[0]);

        // A new unlock must not adopt an import that began under the revoked session.
        activeSession[0] = "session-B";
        assertFalse(authorizer.authorize("memory.private.write"));
        assertEquals("session-A", checkedSession[0]);
    }
}
