package com.patel5600.missminute.mobile.core.policy;

import com.patel5600.missminute.mobile.core.AtomicFiles;
import java.io.File;
import java.io.IOException;

/**
 * Persists {@link PermissionState}. Writes are atomic and keep a {@code .bak}. Loading falls back
 * from the file to its backup, and from there to Observe; a missing file means first run (defaults).
 */
public final class PermissionStore {
    private final File file;

    public PermissionStore(File file) {
        this.file = file;
    }

    private static boolean valid(String text) {
        try {
            PermissionState.fromJson(text);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    public synchronized void save(PermissionState state) throws IOException {
        AtomicFiles.write(file, state.toJson(), PermissionStore::valid);
    }

    public synchronized PermissionState load() {
        File bak = AtomicFiles.backupOf(file);
        if (!file.exists() && !bak.exists()) {
            return PermissionState.defaults();
        }
        PermissionState fromMain = tryRead(file);
        if (fromMain != null) {
            return fromMain;
        }
        PermissionState fromBak = tryRead(bak);
        return fromBak != null ? fromBak : PermissionState.observeOnly();
    }

    private static PermissionState tryRead(File f) {
        try {
            return PermissionState.fromJson(AtomicFiles.read(f));
        } catch (IOException | IllegalArgumentException e) {
            return null;
        }
    }
}