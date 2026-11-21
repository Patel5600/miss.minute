package com.patel5600.missminute.mobile.bridge;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.core.protocol.Role;
import org.junit.Test;

public final class RendererStoragePolicyTest {
    @Test public void legacyDatabaseOriginIsExclusiveToMigrationRenderer() {
        assertEquals("appassets.androidplatform.net", WebHost.hostForRole(Role.MIGRATION));
        assertEquals("dashboard.missminutes.local", WebHost.hostForRole(Role.DASHBOARD));
        assertEquals("overlay.missminutes.local", WebHost.hostForRole(Role.OVERLAY));
        assertNotEquals(WebHost.hostForRole(Role.MIGRATION), WebHost.hostForRole(Role.DASHBOARD));
        assertNotEquals(WebHost.hostForRole(Role.MIGRATION), WebHost.hostForRole(Role.OVERLAY));
    }

    @Test public void normalAppRenderersNeverGetIndexedDb() {
        assertTrue(RendererStoragePolicy.shouldBlockIndexedDb(Role.OVERLAY));
        assertTrue(RendererStoragePolicy.shouldBlockIndexedDb(Role.DASHBOARD));
    }

    @Test public void onlyMigrationRendererGetsIndexedDb() {
        assertFalse(RendererStoragePolicy.shouldBlockIndexedDb(Role.MIGRATION));
    }

    @Test public void failureToHideIndexedDbStopsTheDocumentInsteadOfLoadingTheDashboard() {
        String script = RendererStoragePolicy.indexedDbBlockScript();
        assertTrue(script.contains("Object.defineProperty"));
        assertTrue(script.contains("globalThis.indexedDB==='undefined'"));
        assertTrue(script.contains("document.open()"));
    }

    @Test public void hostingRequiresDocumentStartBlockerOutsideMigrationRole() {
        assertTrue(RendererStoragePolicy.canHost(Role.MIGRATION, true, false));
        assertFalse(RendererStoragePolicy.canHost(Role.MIGRATION, false, true));
        assertFalse(RendererStoragePolicy.canHost(Role.DASHBOARD, true, false));
        assertFalse(RendererStoragePolicy.canHost(Role.OVERLAY, true, false));
        assertTrue(RendererStoragePolicy.canHost(Role.DASHBOARD, true, true));
        assertTrue(RendererStoragePolicy.canHost(Role.OVERLAY, true, true));
    }
}
