package com.patel5600.missminute.mobile.kill;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.core.audit.AuditLog;
import com.patel5600.missminute.mobile.core.kill.KillPath;
import com.patel5600.missminute.mobile.core.kill.KillState;
import com.patel5600.missminute.mobile.core.kill.KillStateStore;
import com.patel5600.missminute.mobile.core.kill.Killable;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class KillSwitchTest {
    private static final String CANARY = "CANARY-secret-payload-5521";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private File stateFile;
    private File auditFile;
    private KillStateStore store;
    private AuditLog audit;
    private final List<String> log = new ArrayList<>();

    @Before
    public void setUp() {
        stateFile = new File(tmp.getRoot(), "kill-state.json");
        auditFile = new File(tmp.getRoot(), "audit.jsonl");
        store = new KillStateStore(stateFile);
        audit = new AuditLog(auditFile, () -> 4242L);
    }

    private KillSwitch.Action record(final String name) {
        return new KillSwitch.Action() {
            @Override
            public void run() {
                log.add(name);
            }
        };
    }

    private KillSwitch.Action fail(final String name) {
        return new KillSwitch.Action() {
            @Override
            public void run() {
                log.add(name);
                throw new IllegalStateException("boom " + CANARY);
            }
        };
    }

    private KillSwitch make(Killable... alwaysThere) {
        return new KillSwitch(store, audit, () -> 4242L, Arrays.asList(alwaysThere));
    }

    @Test
    public void aKillWithNoComponentAliveStillWritesTheStateAndOneAuditRecord() {
        KillSwitch kill = make(); // no service, no registered work, no built-ins
        KillState state = kill.trigger(KillPath.NOTIFICATION);
        assertTrue(state.killed);
        assertTrue(store.read().killed);
        assertEquals(KillPath.NOTIFICATION, store.read().path);
        assertTrue(store.read().noticePending);
        assertEquals(1, audit.size());
    }

    @Test
    public void theKilledStateIsOnDiskBeforeAnyKillableRuns() {
        final boolean[] killedWhenCalled = {false, false};
        KillSwitch kill = make(
                KillSwitch.killable("built-in", new KillSwitch.Action() {
                    @Override
                    public void run() {
                        killedWhenCalled[1] = store.read().killed;
                    }
                }));
        kill.register(KillSwitch.killable("registered", new KillSwitch.Action() {
            @Override
            public void run() {
                killedWhenCalled[0] = store.read().killed;
            }
        }));
        kill.trigger(KillPath.APP_BUTTON);
        assertTrue(killedWhenCalled[0]);
        assertTrue(killedWhenCalled[1]);
    }

    @Test
    public void registeredWorkIsStoppedBeforeTheAlwaysPresentKillables() {
        KillSwitch kill = make(KillSwitch.killable("service", record("service")),
                KillSwitch.killable("settings", record("settings")));
        kill.register(KillSwitch.killable("overlay", record("overlay")));
        kill.register(KillSwitch.killable("speech", record("speech")));
        kill.trigger(KillPath.OVERLAY_MENU);
        assertEquals(Arrays.asList("overlay", "speech", "service", "settings"), log);
    }

    @Test
    public void aThrowingKillableDoesNotStopTheOthers() throws Exception {
        KillSwitch kill = make(KillSwitch.killable("built-in", record("built-in")));
        kill.register(KillSwitch.killable("a", record("a")));
        kill.register(KillSwitch.killable("broken", fail("broken")));
        kill.register(KillSwitch.killable("c", record("c")));
        KillState state = kill.trigger(KillPath.APP_BUTTON);
        assertEquals(Arrays.asList("a", "broken", "c", "built-in"), log);
        assertTrue(state.killed);
        JSONObject record = new JSONObject(audit.tail(1).get(0));
        assertEquals("FAILED", record.getString("outcome"));
        assertTrue(record.getString("detail").contains("failed=1"));
    }

    @Test
    public void aKillableThatUnregisteredIsNotCalled() {
        KillSwitch kill = make();
        KillSwitch.Registration gone = kill.register(KillSwitch.killable("gone", record("gone")));
        kill.register(KillSwitch.killable("stays", record("stays")));
        gone.unregister();
        kill.trigger(KillPath.EXTERNAL);
        assertEquals(Collections.singletonList("stays"), log);
    }

    @Test
    public void listenersHearAboutTheKillOnlyAfterTheAuditRecordExists() {
        KillSwitch kill = make();
        final int[] auditSizeSeen = {-1};
        final KillState[] seen = new KillState[1];
        kill.addListener(new KillSwitch.Listener() {
            @Override
            public void onKilled(KillState state) {
                auditSizeSeen[0] = audit.size();
                seen[0] = state;
            }
        });
        kill.trigger(KillPath.NOTIFICATION);
        assertEquals(1, auditSizeSeen[0]);
        assertNotNull(seen[0]);
        assertEquals(KillPath.NOTIFICATION, seen[0].path);
    }

    @Test
    public void aBrokenListenerDoesNotBreakTheKillOrTheOtherListeners() {
        KillSwitch kill = make(KillSwitch.killable("built-in", record("built-in")));
        final boolean[] second = {false};
        kill.addListener(new KillSwitch.Listener() {
            @Override
            public void onKilled(KillState state) {
                throw new IllegalStateException("listener failed");
            }
        });
        kill.addListener(new KillSwitch.Listener() {
            @Override
            public void onKilled(KillState state) {
                second[0] = true;
            }
        });
        KillState state = kill.trigger(KillPath.APP_BUTTON);
        assertTrue(state.killed);
        assertTrue(second[0]);
        assertEquals(Collections.singletonList("built-in"), log);
    }

    @Test
    public void aRemovedListenerIsNotCalled() {
        KillSwitch kill = make();
        final boolean[] called = {false};
        KillSwitch.Listener listener = new KillSwitch.Listener() {
            @Override
            public void onKilled(KillState state) {
                called[0] = true;
            }
        };
        kill.addListener(listener);
        kill.removeListener(listener);
        kill.trigger(KillPath.EXTERNAL);
        assertFalse(called[0]);
    }

    @Test
    public void eachTriggerAddsExactlyOneAuditRecordNamingItsPath() throws Exception {
        KillSwitch kill = make();
        kill.trigger(KillPath.NOTIFICATION);
        kill.trigger(KillPath.APP_BUTTON);
        kill.trigger(KillPath.OVERLAY_MENU);
        assertEquals(3, audit.size());
        List<String> lines = audit.tail(3);
        assertTrue(new JSONObject(lines.get(0)).getString("detail").contains("path=notification"));
        assertTrue(new JSONObject(lines.get(1)).getString("detail").contains("path=app-button"));
        assertTrue(new JSONObject(lines.get(2)).getString("detail").contains("path=overlay-menu"));
        for (String line : lines) {
            assertEquals("KILL", new JSONObject(line).getString("kind"));
        }
    }

    @Test
    public void noExceptionTextReachesTheAuditLogOrTheStateFile() throws Exception {
        KillSwitch kill = make();
        kill.register(KillSwitch.killable("speech", fail("speech")));
        kill.trigger(KillPath.APP_BUTTON);
        String auditText = new String(Files.readAllBytes(auditFile.toPath()), StandardCharsets.UTF_8);
        String stateText = new String(Files.readAllBytes(stateFile.toPath()), StandardCharsets.UTF_8);
        assertFalse(auditText.contains(CANARY));
        assertFalse(stateText.contains(CANARY));
    }

    @Test
    public void theAuditRecordKeepsItsOutcomeEvenWithTheRealLongLabelList() throws Exception {
        // The labels the app registers: together they are longer than the 80 character audit detail.
        String[] names = {"overlay", "overlay-service", "metadata-service", "notification", "settings", "permissions"};
        Killable[] built = new Killable[names.length];
        for (int i = 0; i < names.length; i++) {
            built[i] = KillSwitch.killable(names[i], record(names[i]));
        }
        make(built).trigger(KillPath.NOTIFICATION);
        JSONObject record = new JSONObject(audit.tail(1).get(0));
        String detail = record.getString("detail");
        assertTrue(detail, detail.length() <= 80);
        assertTrue(detail, detail.startsWith("path=notification;failed=0;saved=true;stopped=overlay"));
        assertEquals("OK", record.getString("outcome"));
        // The complete list is still in the kill state file.
        assertEquals(Arrays.asList(names), store.read().cancelled);
    }

    @Test
    public void clearingTheKillFlagKeepsTheNoticeUntilItIsAcknowledged() {
        KillSwitch kill = make();
        kill.trigger(KillPath.OVERLAY_MENU);
        assertTrue(kill.state().killed);

        assertTrue(kill.clearKillFlag());
        assertFalse("a sticky restart is allowed again", kill.state().killed);
        assertTrue("the notice is still waiting for the owner", kill.state().noticePending);
        assertEquals(KillPath.OVERLAY_MENU, kill.state().path);

        kill.acknowledgeNotice();
        assertFalse(kill.state().noticePending);
        assertFalse(kill.state().killed);
    }

    @Test
    public void acknowledgingTheNoticeDoesNotLiftTheKill() {
        KillSwitch kill = make();
        kill.trigger(KillPath.NOTIFICATION);
        kill.acknowledgeNotice();
        assertFalse(kill.state().noticePending);
        assertTrue("nothing resumes just because the notice was read", kill.state().killed);
    }

    @Test
    public void anUnreadableStateFileCountsAsKilledAndClearingItRepairsIt() throws Exception {
        KillSwitch kill = make();
        kill.trigger(KillPath.APP_BUTTON);
        Files.write(stateFile.toPath(), "{\"killed\":tr".getBytes(StandardCharsets.UTF_8));
        assertTrue(kill.state().killed);
        assertTrue(kill.clearKillFlag());
        assertFalse(kill.state().killed);
    }

    @Test
    public void clearingWhenNothingWasKilledChangesNothing() {
        KillSwitch kill = make();
        assertTrue(kill.clearKillFlag());
        assertFalse(stateFile.exists());
    }

    @Test
    public void killableFactoryKeepsItsLabelAndRunsItsAction() throws Exception {
        Killable killable = KillSwitch.killable("overlay", record("ran"));
        assertEquals("overlay", killable.label());
        killable.onKill();
        assertEquals(Collections.singletonList("ran"), log);
    }
}
