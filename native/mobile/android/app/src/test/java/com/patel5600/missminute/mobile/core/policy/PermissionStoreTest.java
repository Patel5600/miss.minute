package com.patel5600.missminute.mobile.core.policy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.core.AtomicFiles;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class PermissionStoreTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static PermissionState a() {
        return PermissionState.defaults().withMode(Mode.AUTHORIZED).withGrant(Capability.TIMER_CREATE, true)
                .withProactive(true);
    }

    private static PermissionState b() {
        return PermissionState.defaults().withMode(Mode.SUGGEST).withShareWithRemote(true);
    }

    private static void corrupt(File f) throws Exception {
        Files.write(f.toPath(), "{\"mode\":\"AUTH".getBytes(StandardCharsets.UTF_8));
    }

    @Test
    public void firstRunUsesSuggestDefaults() throws Exception {
        PermissionStore store = new PermissionStore(new File(tmp.getRoot(), "permissions.json"));
        PermissionState s = store.load();
        assertEquals(Mode.SUGGEST, s.mode);
        assertFalse(s.proactive);
        assertTrue(s.grants.isEmpty());
    }

    @Test
    public void saveAndLoadRoundTrip() throws Exception {
        PermissionStore store = new PermissionStore(new File(tmp.getRoot(), "p/permissions.json"));
        store.save(a());
        PermissionState s = store.load();
        assertEquals(Mode.AUTHORIZED, s.mode);
        assertTrue(s.isGranted(Capability.TIMER_CREATE));
        assertTrue(s.proactive);
        assertFalse(s.shareWithRemote);
    }

    @Test
    public void aCorruptFileFallsBackToTheBackup() throws Exception {
        File f = new File(tmp.getRoot(), "permissions.json");
        PermissionStore store = new PermissionStore(f);
        store.save(a());
        store.save(b());
        corrupt(f);
        PermissionState s = store.load();
        assertEquals("backup holds the previous good state", Mode.AUTHORIZED, s.mode);
    }

    @Test
    public void bothFilesCorruptFallsBackToObserve() throws Exception {
        File f = new File(tmp.getRoot(), "permissions.json");
        PermissionStore store = new PermissionStore(f);
        store.save(a());
        store.save(b());
        corrupt(f);
        corrupt(AtomicFiles.backupOf(f));
        PermissionState s = store.load();
        assertEquals(Mode.OBSERVE, s.mode);
        assertFalse(s.proactive);
        assertTrue(s.grants.isEmpty());
    }

    @Test
    public void aCorruptFileWithNoBackupFallsBackToObserve() throws Exception {
        File f = new File(tmp.getRoot(), "permissions.json");
        corrupt(f);
        assertEquals(Mode.OBSERVE, new PermissionStore(f).load().mode);
    }

    @Test
    public void aCorruptFileNeverReplacesAGoodBackup() throws Exception {
        File f = new File(tmp.getRoot(), "permissions.json");
        PermissionStore store = new PermissionStore(f);
        store.save(a());
        store.save(b());
        corrupt(f);
        store.save(PermissionState.defaults().withMode(Mode.OBSERVE));
        PermissionState bak = PermissionState.fromJson(AtomicFiles.read(AtomicFiles.backupOf(f)));
        assertEquals("the good backup survived the corrupt file", Mode.AUTHORIZED, bak.mode);
        assertEquals(Mode.OBSERVE, store.load().mode);
    }

    @Test
    public void unknownCapabilityNamesAreRejected() throws Exception {
        File f = new File(tmp.getRoot(), "permissions.json");
        Files.write(f.toPath(), ("{\"mode\":\"AUTHORIZED\",\"grants\":[\"root.access\"],"
                + "\"proactive\":true,\"shareWithRemote\":false}").getBytes(StandardCharsets.UTF_8));
        assertEquals(Mode.OBSERVE, new PermissionStore(f).load().mode);
    }
}