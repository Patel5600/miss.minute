package com.patel5600.missminute.mobile.bridge.handlers;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.core.Clock;
import com.patel5600.missminute.mobile.core.audit.AuditLog;
import com.patel5600.missminute.mobile.core.policy.Mode;
import com.patel5600.missminute.mobile.core.policy.PermissionState;
import com.patel5600.missminute.mobile.core.policy.PermissionStore;
import com.patel5600.missminute.mobile.core.protocol.Role;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class PermissionHandlersTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final UiBridge NOOP_UI = new UiBridge() {
        @Override public void runOnUi(Runnable action) { action.run(); }
        @Override public void confirm(int titleRes, int messageRes, Confirmed result) { result.onResult(false); }
        @Override public void openOverlayPermissionScreen() {}
        @Override public void requestNotificationPermission() {}
        @Override public boolean notificationsGranted() { return false; }
        @Override public void openMetadataWatcher() {}
        @Override public void push(String eventName, JSONObject payload) {}
        @Override public void refreshOwnerControls() {}
    };

    private static String request(String id, String mode) throws Exception {
        return new JSONObject()
                .put("v", 1)
                .put("id", id)
                .put("type", "permissions.setMode")
                .put("payload", new JSONObject().put("mode", mode))
                .toString();
    }

    @Test
    public void guestOrCandidateSessionIsRefusedWithRestrictedToOwner() throws Exception {
        PermissionStore store = new PermissionStore(new File(tmp.getRoot(), "permissions.json"));
        store.save(PermissionState.defaults().withMode(Mode.SUGGEST));
        AuditLog audit = new AuditLog(new File(tmp.getRoot(), "audit.jsonl"), new Clock() {
            @Override public long nowMs() { return 1000L; }
        });

        BridgeRouter router = new BridgeRouter(Role.DASHBOARD);
        PermissionHandlers.register(router, null, NOOP_UI, store, audit, () -> false);

        List<String> sent = new ArrayList<>();
        router.dispatch(request("r1", "OBSERVE"), sent::add);
        router.dispatch(request("r2", "SUGGEST"), sent::add);
        router.dispatch(request("r3", "AUTHORIZED"), sent::add);

        assertEquals(3, sent.size());
        for (String raw : sent) {
            JSONObject reply = new JSONObject(raw);
            assertFalse(reply.getBoolean("ok"));
            assertEquals("restricted_to_owner", reply.getJSONObject("error").getString("code"));
        }
        assertEquals(Mode.SUGGEST, store.load().mode);
    }

    @Test
    public void linkageFailureInOwnerGateFailsClosed() throws Exception {
        PermissionStore store = new PermissionStore(new File(tmp.getRoot(), "permissions.json"));
        AuditLog audit = new AuditLog(new File(tmp.getRoot(), "audit.jsonl"), () -> 1000L);

        BridgeRouter router = new BridgeRouter(Role.DASHBOARD);
        PermissionHandlers.register(router, null, NOOP_UI, store, audit, () -> {
            throw new UnsatisfiedLinkError("jni missing in unit test");
        });

        List<String> sent = new ArrayList<>();
        router.dispatch(request("r-link", "OBSERVE"), sent::add);
        assertEquals(1, sent.size());
        JSONObject reply = new JSONObject(sent.get(0));
        assertFalse(reply.getBoolean("ok"));
        assertEquals("restricted_to_owner", reply.getJSONObject("error").getString("code"));
    }

    @Test
    public void authenticatedOwnerMayTightenPermissionModeDirectly() throws Exception {
        PermissionStore store = new PermissionStore(new File(tmp.getRoot(), "permissions.json"));
        store.save(PermissionState.defaults().withMode(Mode.SUGGEST));
        AuditLog audit = new AuditLog(new File(tmp.getRoot(), "audit.jsonl"), () -> 2000L);

        BridgeRouter router = new BridgeRouter(Role.DASHBOARD);
        PermissionHandlers.register(router, null, NOOP_UI, store, audit, () -> true);

        List<String> sent = new ArrayList<>();
        router.dispatch(request("r-ok", "OBSERVE"), sent::add);
        assertEquals(1, sent.size());
        JSONObject reply = new JSONObject(sent.get(0));
        assertTrue(reply.getBoolean("ok"));
        assertEquals("OBSERVE", reply.getJSONObject("payload").getString("mode"));
        assertEquals(Mode.OBSERVE, store.load().mode);
    }
}
