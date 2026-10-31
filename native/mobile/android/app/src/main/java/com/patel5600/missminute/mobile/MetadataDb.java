package com.patel5600.missminute.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;

import net.zetetic.database.sqlcipher.SQLiteDatabase;

import java.io.File;
import java.util.Objects;

/**
 * Encrypted local metadata ledger. A missing/wrong key is an error, never an
 * instruction to recreate the database and silently discard the owner's history.
 */
final class MetadataDb implements AutoCloseable {
    private static final String DATABASE_NAME = "miss-minutes-mobile.db";
    private static final int SCHEMA_VERSION = 1;

    private final SQLiteDatabase database;

    MetadataDb(Context context) throws Exception {
        // SQLCipher requires its bundled native library to be loaded before
        // any database class is used.
        System.loadLibrary("sqlcipher");

        File file = context.getDatabasePath(DATABASE_NAME);
        File parent = file.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) {
            throw new IllegalStateException("Cannot create the private metadata database directory.");
        }

        String password = AndroidDatabaseKey.databasePassword(context, file);
        database = SQLiteDatabase.openOrCreateDatabase(file, password, null, null, null);
        try {
            database.execSQL("PRAGMA journal_mode=WAL");
            database.execSQL("PRAGMA synchronous=FULL");
            database.execSQL("PRAGMA secure_delete=ON");
            database.execSQL("PRAGMA cipher_memory_security=ON");
            database.execSQL("PRAGMA foreign_keys=ON");
            verifyCipher();
            initializeSchema();
        } catch (Exception error) {
            database.close();
            throw error;
        }
    }

    private void verifyCipher() {
        try (Cursor cursor = database.rawQuery("PRAGMA cipher_version", null)) {
            if (!cursor.moveToFirst() || cursor.isNull(0) || cursor.getString(0).trim().isEmpty()) {
                throw new IllegalStateException("SQLCipher is not active; refusing plaintext database access.");
            }
        }
    }

    private void initializeSchema() {
        int version = database.getVersion();
        if (version > SCHEMA_VERSION) {
            throw new IllegalStateException(
                "Metadata database schema is newer than this app. Refusing a destructive downgrade."
            );
        }
        if (version == SCHEMA_VERSION) return;
        if (version != 0) {
            throw new IllegalStateException("A metadata database migration is required.");
        }

        database.beginTransaction();
        try {
            database.execSQL(
                "CREATE TABLE snapshots(" +
                "document_id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, " +
                "size INTEGER NOT NULL, modified INTEGER NOT NULL)"
            );
            database.execSQL(
                "CREATE TABLE events(" +
                "seq INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, " +
                "event_type TEXT NOT NULL, observed_at INTEGER NOT NULL, details TEXT NOT NULL)"
            );
            database.execSQL("CREATE INDEX events_observed_idx ON events(observed_at DESC)");
            database.setVersion(SCHEMA_VERSION);
            database.setTransactionSuccessful();
        } finally {
            database.endTransaction();
        }
    }

    synchronized void observe(String id, String name, String mime, long size, long modified) {
        String safeName = name == null ? "" : name;
        String safeMime = mime == null ? "application/octet-stream" : mime;
        database.beginTransaction();
        try {
            String oldName = null;
            String oldMime = null;
            long oldSize = Long.MIN_VALUE;
            long oldModified = Long.MIN_VALUE;

            try (Cursor cursor = database.query(
                "snapshots",
                new String[]{"name", "mime", "size", "modified"},
                "document_id=?",
                new String[]{id},
                null,
                null,
                null
            )) {
                if (cursor.moveToFirst()) {
                    oldName = cursor.getString(0);
                    oldMime = cursor.getString(1);
                    oldSize = cursor.getLong(2);
                    oldModified = cursor.getLong(3);
                }
            }

            boolean discovered = oldName == null;
            boolean changed = discovered
                || !Objects.equals(oldName, safeName)
                || !Objects.equals(oldMime, safeMime)
                || oldSize != size
                || oldModified != modified;

            ContentValues snapshot = new ContentValues();
            snapshot.put("document_id", id);
            snapshot.put("name", safeName);
            snapshot.put("mime", safeMime);
            snapshot.put("size", size);
            snapshot.put("modified", modified);
            long stored = database.insertWithOnConflict(
                "snapshots",
                null,
                snapshot,
                SQLiteDatabase.CONFLICT_REPLACE
            );
            if (stored < 0) {
                throw new IllegalStateException("Could not persist encrypted metadata snapshot.");
            }

            if (changed) {
                ContentValues event = new ContentValues();
                event.put("document_id", id);
                event.put("event_type", discovered ? "document.discovered" : "document.metadata_changed");
                event.put("observed_at", System.currentTimeMillis());
                event.put("details", "Metadata only; document contents were not opened.");
                if (database.insert("events", null, event) < 0) {
                    throw new IllegalStateException("Could not append encrypted metadata event.");
                }
            }
            database.setTransactionSuccessful();
        } finally {
            database.endTransaction();
        }
    }

    synchronized void trimEvents() {
        database.execSQL(
            "DELETE FROM events WHERE seq NOT IN " +
            "(SELECT seq FROM events ORDER BY seq DESC LIMIT 10000)"
        );
    }

    @Override
    public synchronized void close() {
        database.close();
    }
}
