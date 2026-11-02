package com.patel5600.missminute.mobile.core.kill;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.core.Clock;
import com.patel5600.missminute.mobile.core.audit.AuditLog;
import com.patel5600.missminute.mobile.core.policy.Mode;
import com.patel5600.missminute.mobile.core.policy.PermissionState;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class KillCoreTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String CANARY = "CANARY-secret-payload-9137";

    private static Killable killable(final String label, final List<String> log, final Runnable before,
                                     final boolean fail) {
        return new Killable() {
            @Override
            public String label() {
                return label;
            }

            @Override
            public void onKill() throws Exception {
                if (before != null) {
                    before.run();
                }
                log.add(label);
                if (fail) {
                    throw new IllegalStateException("boom " + CANARY);
                }
            }
        };
    }

    @Test
    public void writesTheKilledStateBeforeCallingAnyKillable() throws Exception {
        final KillStateStore store = new KillStateStore(new File(tmp.getRoot(), "kill-state.json"));
        final AuditLog audit = new AuditLog(new File(tmp.getRoot(), "audit.jsonl"), () -> 1234L);
        final List<String> log = new ArrayList<>();
        final boolean[] killedWhenCalled = {false};
        Runnable check = () -> killedWhenCalled[0] = store.read().killed;
        KillState state = KillCore.trigger(KillPath.APP_BUTTON,
                Arrays.asList(killable("service", log, check, false), killable("overlay", log, check, false)),
                store, audit, () -> 1234L);
        assertTrue(killedWhenCalled[0]);
        assertTrue(state.killed);
        assertTrue(store.read().killed);
        assertEquals(KillPath.APP_BUTTON, store.read().path);
        assertEquals(Arrays.asList("service", "overlay"), store.read().cancelled);
        assertTrue(store.read().noticePending);
        assertEquals(1234L, store.read().atMs);
    }

    @Test
    public void everyKillableRunsEvenWhenOneThrows() throws Exception {
        KillStateStore store = new KillStateStore(new File(tmp.getRoot(), "kill-state.json"));
        AuditLog audit = new AuditLog(new File(tmp.getRoot(), "audit.jsonl"), () -> 99L);
        List<String> log = new ArrayList<>();
        KillCore.trigger(KillPath.NOTIFICATION,
                Arrays.asList(killable("a", log, null, false), killable("b", log, null, true),
                        killable("c", log, null, false)),
                store, audit, () -> 99L);
        assertEquals(Arrays.asList("a", "b", "c"), log);
        assertEquals(1, audit.size());
        JSONObject rec = new JSONObject(audit.tail(1).get(0));
        assertEquals("FAILED", rec.getString("outcome"));
        assertTrue(rec.getString("detail").contains("failed=1"));
    }

    @Test
    public void theAuditRecordHoldsPathTimeAndLabelsButNoPayloadText() throws Exception {
        File auditFile = new File(tmp.getRoot(), "audit.jsonl");
        KillStateStore store = new KillStateStore(new File(tmp.getRoot(), "kill-state.json"));
        AuditLog audit = new AuditLog(auditFile, () -> 777L);
        KillCore.trigger(KillPath.OVERLAY_MENU,
                Arrays.asList(killable("speech", new ArrayList<String>(), null, true),
                        killable("request", new ArrayList<String>(), null, false)),
                store, audit, () -> 777L);
        String line = audit.tail(1).get(0);
        JSONObject rec = new JSONObject(line);
        assertEquals("KILL", rec.getString("kind"));
        assertEquals(777L, rec.getLong("t"));
        assertTrue(rec.getString("detail").contains("path=overlay-menu"));
        assertTrue(rec.getString("detail").contains("speech,request"));
        assertFalse(line.contains(CANARY));
        String onDisk = new String(Files.readAllBytes(auditFile.toPath()), StandardCharsets.UTF_8);
        assertFalse(onDisk.contains(CANARY));
        String stateOnDisk = new String(Files.readAllBytes(new File(tmp.getRoot(), "kill-state.json").toPath()),
                StandardCharsets.UTF_8);
        assertFalse(stateOnDisk.contains(CANARY));
    }

    @Test
    public void aMissingStateFileMeansNotKilled() {
        KillStateStore store = new KillStateStore(new File(tmp.getRoot(), "kill-state.json"));
        assertFalse(store.read().killed);
    }

    @Test
    public void aCorruptOrTruncatedStateFileReadsAsKilled() throws Exception {
        File f = new File(tmp.getRoot(), "kill-state.json");
        KillStateStore store = new KillStateStore(f);
        store.write(new KillState(false, 0, KillPath.EXTERNAL, new ArrayList<String>(), false));
        store.write(new KillState(false, 0, KillPath.EXTERNAL, new ArrayList<String>(), false));
        assertFalse(store.read().killed);
        // The backup says "not killed"; a truncated main file must still read as killed.
        Files.write(f.toPath(), "{\"killed\":fal".getBytes(StandardCharsets.UTF_8));
        assertTrue(store.read().killed);
        Files.write(f.toPath(), new byte[0]);
        assertTrue(store.read().killed);
        Files.write(f.toPath(), "[]".getBytes(StandardCharsets.UTF_8));
        assertTrue(store.read().killed);
    }

    @Test
    public void afterAKillPermissionsReturnToObserveWithProactiveOff() {
        PermissionState before = PermissionState.defaults().withMode(Mode.AUTHORIZED).withProactive(true);
        PermissionState after = KillCore.applyAfterKill(before);
        assertEquals(Mode.OBSERVE, after.mode);
        assertFalse(after.proactive);
    }

    @Test
    public void acknowledgingTheNoticeClearsItButKeepsTheKill() throws Exception {
        KillStateStore store = new KillStateStore(new File(tmp.getRoot(), "kill-state.json"));
        Clock clock = () -> 5L;
        AuditLog audit = new AuditLog(new File(tmp.getRoot(), "audit.jsonl"), clock);
        KillState state = KillCore.trigger(KillPath.EXTERNAL, new ArrayList<Killable>(), store, audit, clock);
        store.write(state.withNoticeAcknowledged());
        assertTrue(store.read().killed);
        assertFalse(store.read().noticePending);
    }
}