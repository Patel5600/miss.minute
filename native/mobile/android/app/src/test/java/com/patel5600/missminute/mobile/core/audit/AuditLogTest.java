package com.patel5600.missminute.mobile.core.audit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.core.policy.Capability;
import com.patel5600.missminute.mobile.core.policy.Decision;
import com.patel5600.missminute.mobile.core.policy.Initiator;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class AuditLogTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private AuditLog open(File f) {
        return new AuditLog(f, () -> 42L);
    }

    @Test
    public void recordsAreOneJsonLineWithTheEnumeratedFields() throws Exception {
        File f = new File(tmp.getRoot(), "audit.jsonl");
        AuditLog log = open(f);
        AuditRecord r = log.append(AuditRecord.Kind.TOOL, Capability.TIMER_CREATE, Decision.Outcome.ALLOW,
                Initiator.MODEL, AuditRecord.Outcome.OK, "seconds=300");
        assertEquals(1, r.seq);
        JSONObject o = new JSONObject(log.tail(1).get(0));
        assertEquals("TOOL", o.getString("kind"));
        assertEquals("timer.create", o.getString("cap"));
        assertEquals("ALLOW", o.getString("decision"));
        assertEquals("MODEL", o.getString("initiator"));
        assertEquals("OK", o.getString("outcome"));
        assertEquals(42L, o.getLong("t"));
        assertEquals(1, Files.readAllLines(f.toPath(), StandardCharsets.UTF_8).size());
    }

    @Test
    public void keepsOnlyTheLast2000Lines() throws Exception {
        File f = new File(tmp.getRoot(), "audit.jsonl");
        AuditLog log = open(f);
        for (int i = 0; i < 2500; i++) {
            log.append(AuditRecord.Kind.SETTINGS, null, null, Initiator.OWNER, AuditRecord.Outcome.OK, "n=" + i);
        }
        assertEquals(2000, log.size());
        List<String> lines = Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
        assertEquals(2000, lines.size());
        assertEquals(501, new JSONObject(lines.get(0)).getLong("seq"));
        assertEquals(2500, new JSONObject(lines.get(1999)).getLong("seq"));

        AuditLog reopened = open(f);
        assertEquals(2000, reopened.size());
        assertEquals(2501, reopened.append(AuditRecord.Kind.SETTINGS, null, null, Initiator.OWNER,
                AuditRecord.Outcome.OK, "next").seq);
    }

    @Test
    public void detailIsCappedAt80PrintableAsciiCharacters() throws Exception {
        AuditLog log = open(new File(tmp.getRoot(), "audit.jsonl"));
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 200; i++) {
            sb.append(i % 7 == 0 ? '\n' : 'x');
        }
        AuditRecord r = log.append(AuditRecord.Kind.TOOL, null, null, null, AuditRecord.Outcome.NONE, sb.toString());
        assertEquals(80, r.detail.length());
        assertFalse(r.detail.contains("\n"));
        assertEquals("caf?", log.append(AuditRecord.Kind.TOOL, null, null, null, AuditRecord.Outcome.NONE,
                "caf\u00e9").detail);
        assertEquals("", log.append(AuditRecord.Kind.TOOL, null, null, null, AuditRecord.Outcome.NONE, null).detail);
    }

    @Test
    public void concurrentAppendsKeepEverySequenceNumberUnique() throws Exception {
        final AuditLog log = open(new File(tmp.getRoot(), "audit.jsonl"));
        final Set<Long> seqs = java.util.Collections.synchronizedSet(new HashSet<Long>());
        List<Thread> threads = new ArrayList<>();
        for (int t = 0; t < 8; t++) {
            Thread th = new Thread(() -> {
                for (int i = 0; i < 200; i++) {
                    seqs.add(log.append(AuditRecord.Kind.TOOL, null, null, Initiator.MODEL, AuditRecord.Outcome.OK,
                            "x").seq);
                }
            });
            threads.add(th);
            th.start();
        }
        for (Thread th : threads) {
            th.join();
        }
        assertEquals(1600, seqs.size());
        assertEquals(1600, log.size());
        for (String line : log.tail(1600)) {
            new JSONObject(line);
        }
        assertTrue(seqs.contains(1600L));
    }
}