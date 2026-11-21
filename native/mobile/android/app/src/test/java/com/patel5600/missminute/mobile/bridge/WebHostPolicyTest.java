package com.patel5600.missminute.mobile.bridge;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class WebHostPolicyTest {
    @Test public void bundledWebViewsCannotCreateWorkersOrMakeDirectNetworkRequests() {
        assertTrue(WebHost.CSP.contains("worker-src 'none'"));
        assertTrue(WebHost.CSP.contains("connect-src 'self'"));
        assertFalse(WebHost.CSP.contains("connect-src 'self' https:"));
    }

    @Test public void privateRepliesAreDroppedForDestroyedOrSupersededDocuments() {
        assertFalse(WebHost.mayPostToCurrentDocument(true, true));
        assertFalse(WebHost.mayPostToCurrentDocument(false, false));
        assertTrue(WebHost.mayPostToCurrentDocument(false, true));
    }
}
