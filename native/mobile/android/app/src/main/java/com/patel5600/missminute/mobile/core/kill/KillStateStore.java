package com.patel5600.missminute.mobile.core.kill;

import com.patel5600.missminute.mobile.core.AtomicFiles;
import java.io.File;
import java.io.IOException;

/**
 * Persists {@link KillState}. A missing file means nothing was killed; a file that exists but
 * cannot be read counts as killed, and the backup is deliberately never consulted (an old backup
 * could say "not killed").
 */
public final class KillStateStore {
    private final File file;

    public KillStateStore(File file) {
        this.file = file;
    }

    public synchronized void write(KillState state) throws IOException {
        AtomicFiles.write(file, state.toJson(), text -> {
            try {
                KillState.fromJson(text);
                return true;
            } catch (IllegalArgumentException e) {
                return false;
            }
        });
    }

    public synchronized KillState read() {
        if (!file.exists()) {
            return KillState.notKilled();
        }
        try {
            return KillState.fromJson(AtomicFiles.read(file));
        } catch (IOException | IllegalArgumentException e) {
            return KillState.unreadable();
        }
    }
}