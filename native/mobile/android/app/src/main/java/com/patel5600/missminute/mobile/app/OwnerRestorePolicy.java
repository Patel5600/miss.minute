package com.patel5600.missminute.mobile.app;

/** Process-lifecycle policy for restoring the persisted public owner registry. */
final class OwnerRestorePolicy {
    private OwnerRestorePolicy() {}

    /** Restore once per process; Activity recreation must not reset the live Rust session. */
    static boolean shouldRestore(boolean registryRestoredInProcess) {
        return !registryRestoredInProcess;
    }
}
