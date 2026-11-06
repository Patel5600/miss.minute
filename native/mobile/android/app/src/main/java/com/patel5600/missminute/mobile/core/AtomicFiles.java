package com.patel5600.missminute.mobile.core;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.function.Predicate;

/**
 * Crash-safe small-file writes: write a temp file, fsync it, keep the previous good version as
 * {@code <name>.bak}, then rename over the target.
 */
public final class AtomicFiles {
    private AtomicFiles() {
    }

    public static File backupOf(File target) {
        return new File(target.getParentFile(), target.getName() + ".bak");
    }

    /**
     * @param existingIsValid decides whether the current file is good enough to become the backup;
     *                        a corrupt file never overwrites a good backup
     */
    public static void write(File target, String text, Predicate<String> existingIsValid) throws IOException {
        File dir = target.getAbsoluteFile().getParentFile();
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("cannot create " + dir);
        }
        File tmp = new File(dir, target.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        }
        if (target.exists()) {
            String current = null;
            try {
                current = read(target);
            } catch (IOException ignored) {
                // an unreadable file cannot become the backup
            }
            if (current != null && existingIsValid.test(current)) {
                Files.copy(target.toPath(), backupOf(target).toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
        }
        try {
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }

    public static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }
}