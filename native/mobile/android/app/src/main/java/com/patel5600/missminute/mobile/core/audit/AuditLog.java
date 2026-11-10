package com.patel5600.missminute.mobile.core.audit;

import com.patel5600.missminute.mobile.core.Clock;
import com.patel5600.missminute.mobile.core.policy.Capability;
import com.patel5600.missminute.mobile.core.policy.Decision;
import com.patel5600.missminute.mobile.core.policy.Initiator;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/** Bounded JSONL audit trail: the last 2000 lines are kept. Thread-safe. */
public final class AuditLog {
    public static final int MAX_LINES = 2000;

    private final File file;
    private final Clock clock;
    private final List<String> lines = new ArrayList<>();
    private long nextSeq = 1;

    public AuditLog(File file, Clock clock) {
        this.file = file;
        this.clock = clock;
        load();
    }

    private void load() {
        if (!file.exists()) {
            return;
        }
        try {
            for (String line : Files.readAllLines(file.toPath(), StandardCharsets.UTF_8)) {
                if (!line.trim().isEmpty()) {
                    lines.add(line);
                }
            }
        } catch (IOException e) {
            return;
        }
        while (lines.size() > MAX_LINES) {
            lines.remove(0);
        }
        if (!lines.isEmpty()) {
            try {
                nextSeq = new JSONObject(lines.get(lines.size() - 1)).getLong("seq") + 1;
            } catch (JSONException e) {
                nextSeq = lines.size() + 1;
            }
        }
    }

    /** Appends one record and returns it. */
    public synchronized AuditRecord append(AuditRecord.Kind kind, Capability capability, Decision.Outcome decision,
                                           Initiator initiator, AuditRecord.Outcome outcome, String detail) {
        AuditRecord record = new AuditRecord(nextSeq++, clock.nowMs(), kind, capability, decision, initiator,
                outcome, detail);
        lines.add(record.toJsonLine());
        boolean trimmed = false;
        while (lines.size() > MAX_LINES) {
            lines.remove(0);
            trimmed = true;
        }
        try {
            if (trimmed || !file.exists()) {
                rewrite();
            } else {
                File dir = file.getAbsoluteFile().getParentFile();
                if (!dir.isDirectory()) {
                    dir.mkdirs();
                }
                try (FileOutputStream out = new FileOutputStream(file, true)) {
                    out.write((record.toJsonLine() + "\n").getBytes(StandardCharsets.UTF_8));
                }
            }
        } catch (IOException e) {
            // Keep the in-memory copy; a full disk must not break the action being audited.
        }
        return record;
    }

    private void rewrite() throws IOException {
        File dir = file.getAbsoluteFile().getParentFile();
        if (!dir.isDirectory()) {
            dir.mkdirs();
        }
        StringBuilder sb = new StringBuilder();
        for (String l : lines) {
            sb.append(l).append('\n');
        }
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        }
    }

    /** The last {@code limit} lines, oldest first. */
    public synchronized List<String> tail(int limit) {
        int from = Math.max(0, lines.size() - limit);
        return new ArrayList<>(lines.subList(from, lines.size()));
    }

    public synchronized int size() {
        return lines.size();
    }
}