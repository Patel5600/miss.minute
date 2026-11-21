package com.patel5600.missminute.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;

import net.zetetic.database.sqlcipher.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Encrypted owner application data. Every caller must already pass the native owner-session gate. */
public final class OwnerDataDb implements AutoCloseable {
    private static final String NAME = "miss-minutes-owner.db";
    private static final int SCHEMA_VERSION = 1;
    private static final int MAX_RECORD_BYTES = 2 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
    private static final Set<String> STORES = new HashSet<>(Arrays.asList(
            "chats", "messages", "memories", "schedule", "todos", "timers", "notes", "activity", "kv",
            "missions", "offers", "calls", "delegations", "audit_chain", "connectors"));
    private static final Set<String> PROVIDERS = new HashSet<>(Arrays.asList(
            "openai", "gemini", "anthropic", "openrouter", "ollama", "elevenlabs"));

    private final SQLiteDatabase db;

    public OwnerDataDb(Context context) throws Exception {
        System.loadLibrary("sqlcipher");
        File file = context.getDatabasePath(NAME);
        File parent = file.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) {
            throw new IllegalStateException("Cannot create the private owner database directory.");
        }
        String password = AndroidDatabaseKey.databasePassword(context, file);
        db = SQLiteDatabase.openOrCreateDatabase(file, password, null, null, null);
        try {
            // These pragmas return a result row. SQLCipher's execSQL intentionally rejects
            // query-shaped statements with "Queries can be performed using ... query or rawQuery".
            applyPragma("PRAGMA journal_mode=WAL");
            applyPragma("PRAGMA synchronous=FULL");
            applyPragma("PRAGMA secure_delete=ON");
            applyPragma("PRAGMA cipher_memory_security=ON");
            verifyCipher();
            initialize();
        } catch (Exception e) {
            db.close();
            throw e;
        }
    }

    private void applyPragma(String sql) {
        try (Cursor cursor = db.rawQuery(sql, null)) {
            // Force execution and consume any returned rows before closing the cursor.
            while (cursor.moveToNext()) { /* pragma result consumed */ }
        }
    }

    private void verifyCipher() {
        try (Cursor cursor = db.rawQuery("PRAGMA cipher_version", null)) {
            if (!cursor.moveToFirst() || cursor.isNull(0) || cursor.getString(0).trim().isEmpty()) {
                throw new IllegalStateException("SQLCipher is not active; refusing plaintext owner data.");
            }
        }
    }

    private void initialize() {
        int version = db.getVersion();
        if (version > SCHEMA_VERSION) throw new IllegalStateException("Owner database is newer than this app.");
        if (version == SCHEMA_VERSION) return;
        if (version != 0) throw new IllegalStateException("Owner database migration is required.");
        db.beginTransaction();
        try {
            db.execSQL("CREATE TABLE records(store TEXT NOT NULL, record_key TEXT NOT NULL, partition_key TEXT, sort_value REAL NOT NULL DEFAULT 0, json TEXT NOT NULL, PRIMARY KEY(store, record_key))");
            db.execSQL("CREATE INDEX records_partition_idx ON records(store, partition_key, sort_value)");
            db.execSQL("CREATE INDEX records_sort_idx ON records(store, sort_value)");
            db.execSQL("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
            db.setVersion(SCHEMA_VERSION);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private static String storeName(String store) {
        if (!STORES.contains(store)) throw new IllegalArgumentException("Unknown owner data store.");
        return store;
    }

    private static String recordKey(String store, JSONObject value) {
        String field = "kv".equals(store) ? "key" : "id";
        String key = value.optString(field, "");
        if (key.isEmpty() || key.length() > 256) throw new IllegalArgumentException("The record key is invalid.");
        return key;
    }

    private static ContentValues values(String store, JSONObject value) throws JSONException {
        String json = value.toString();
        if (json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > MAX_RECORD_BYTES) {
            throw new IllegalArgumentException("The owner data record is too large.");
        }
        ContentValues row = new ContentValues();
        row.put("store", storeName(store));
        row.put("record_key", recordKey(store, value));
        if ("messages".equals(store)) row.put("partition_key", value.optString("chatId", ""));
        else row.putNull("partition_key");
        double sortValue = "schedule".equals(store) ? value.optDouble("startAt", 0)
                : "activity".equals(store) ? value.optDouble("at", 0)
                : value.optDouble("updatedAt", value.optDouble("createdAt", 0));
        row.put("sort_value", sortValue);
        row.put("json", json);
        return row;
    }

    private void upsert(String store, JSONObject value) throws JSONException {
        ContentValues row = values(store, value);
        long result = db.insertWithOnConflict("records", null, row, SQLiteDatabase.CONFLICT_REPLACE);
        if (result < 0) throw new IllegalStateException("Could not persist encrypted owner data.");
    }

    private static void appendResult(JSONArray out, String json, int[] bytes) throws JSONException {
        bytes[0] += json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        if (bytes[0] > MAX_RESPONSE_BYTES) throw new IllegalStateException("The requested owner data set is too large to return safely.");
        out.put(new JSONObject(json));
    }

    public synchronized JSONArray execute(JSONObject request) throws Exception {
        String op = request.optString("op", "");
        String store = request.optString("store", "");
        if (op.equals("migrationStatus")) {
            return new JSONArray().put(new JSONObject().put("done", "1".equals(metadata("legacy_idb_migrated"))));
        }
        if (op.equals("importBatch")) {
            storeName(store);
            JSONArray rows = request.optJSONArray("records");
            if (rows == null || rows.length() > 1000) throw new IllegalArgumentException("The migration batch is invalid.");
            db.beginTransaction();
            try {
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject item = rows.optJSONObject(i);
                    if (item == null) throw new IllegalArgumentException("The migration contains an invalid record.");
                    if ("kv".equals(store) && isProviderSecretKey(item.optString("key", ""))) {
                        // Credentials imported from the old browser vault remain native-only.
                        validateProvider(item.optString("key").substring("vault:web:secret:".length()));
                        String secret = item.optString("value", "");
                        if (!secret.isEmpty()) putCredential(item.optString("key").substring("vault:web:secret:".length()), secret);
                        continue;
                    }
                    upsert(store, item);
                }
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return new JSONArray();
        }
        if (op.equals("migrationComplete")) {
            setMetadata("legacy_idb_migrated", "1");
            return new JSONArray();
        }
        if (op.equals("list")) {
            storeName(store);
            JSONArray out = new JSONArray();
            int[] bytes = {0};
            String selection = "kv".equals(store) ? "store=? AND record_key NOT LIKE 'vault:web:secret:%'" : "store=?";
            try (Cursor cursor = db.query("records", new String[]{"json"}, selection, new String[]{store}, null, null, "sort_value ASC")) {
                while (cursor.moveToNext()) appendResult(out, cursor.getString(0), bytes);
            }
            return out;
        }
        if (op.equals("messagesForChat")) {
            JSONArray out = new JSONArray();
            int[] bytes = {0};
            try (Cursor cursor = db.query("records", new String[]{"json"}, "store='messages' AND partition_key=?", new String[]{request.optString("chatId", "")}, null, null, "sort_value ASC")) {
                while (cursor.moveToNext()) appendResult(out, cursor.getString(0), bytes);
            }
            return out;
        }
        if (op.equals("scheduleBetween")) {
            JSONArray out = new JSONArray();
            int[] bytes = {0};
            try (Cursor cursor = db.query("records", new String[]{"json"}, "store='schedule' AND sort_value>=? AND sort_value<?", new String[]{Double.toString(request.optDouble("from")), Double.toString(request.optDouble("to"))}, null, null, "sort_value ASC")) {
                while (cursor.moveToNext()) appendResult(out, cursor.getString(0), bytes);
            }
            return out;
        }
        if (op.equals("get")) {
            storeName(store);
            if ("kv".equals(store) && isProviderSecretKey(request.optString("key", ""))) {
                throw new IllegalArgumentException("Provider credentials are available only to the native provider service.");
            }
            try (Cursor cursor = db.query("records", new String[]{"json"}, "store=? AND record_key=?", new String[]{store, request.optString("key", "")}, null, null, null)) {
                return cursor.moveToFirst() ? new JSONArray().put(new JSONObject(cursor.getString(0))) : new JSONArray();
            }
        }
        if (op.equals("put")) {
            if ("kv".equals(store) && isProviderSecretKey(requireRecord(request).optString("key", ""))) {
                throw new IllegalArgumentException("Provider credentials must use the native credential service.");
            }
            db.beginTransaction();
            try { upsert(store, requireRecord(request)); db.setTransactionSuccessful(); }
            finally { db.endTransaction(); }
            return new JSONArray();
        }
        if (op.equals("putMany")) {
            JSONArray rows = request.optJSONArray("records");
            if (rows == null || rows.length() > 1000) throw new IllegalArgumentException("The record batch is invalid.");
            db.beginTransaction();
            try {
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject item = rows.optJSONObject(i);
                    if (item == null) throw new IllegalArgumentException("The record batch contains an invalid entry.");
                    upsert(store, item);
                }
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return new JSONArray();
        }
        if (op.equals("delete")) {
            db.delete("records", "store=? AND record_key=?", new String[]{storeName(store), request.optString("key", "")});
            return new JSONArray();
        }
        if (op.equals("clear")) {
            db.delete("records", "store=?", new String[]{storeName(store)});
            return new JSONArray();
        }
        if (op.equals("saveMessage")) {
            JSONObject message = requireRecord(request);
            db.beginTransaction();
            try {
                upsert("messages", message);
                String chatId = message.optString("chatId", "");
                try (Cursor cursor = db.query("records", new String[]{"json"}, "store='chats' AND record_key=?", new String[]{chatId}, null, null, null)) {
                    if (cursor.moveToFirst()) {
                        JSONObject chat = new JSONObject(cursor.getString(0));
                        chat.put("updatedAt", Math.max(chat.optLong("updatedAt"), message.optLong("createdAt")));
                        upsert("chats", chat);
                    }
                }
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return new JSONArray();
        }
        if (op.equals("deleteChat")) {
            String chatId = request.optString("chatId", "");
            db.beginTransaction();
            try {
                db.delete("records", "store='messages' AND partition_key=?", new String[]{chatId});
                db.delete("records", "store='chats' AND record_key=?", new String[]{chatId});
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return new JSONArray();
        }
        if (op.equals("logActivity")) {
            JSONObject record = requireRecord(request);
            db.beginTransaction();
            try {
                upsert("activity", record);
                db.execSQL("DELETE FROM records WHERE store='activity' AND record_key NOT IN (SELECT record_key FROM records WHERE store='activity' ORDER BY sort_value DESC LIMIT 500)");
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return new JSONArray();
        }
        if (op.equals("wipe")) {
            db.beginTransaction();
            try {
                db.delete("records", null, null);
                db.delete("metadata", null, null);
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return new JSONArray();
        }
        throw new IllegalArgumentException("Unsupported owner data operation.");
    }

    private static JSONObject requireRecord(JSONObject request) {
        JSONObject value = request.optJSONObject("record");
        if (value == null) throw new IllegalArgumentException("The owner data record is missing.");
        return value;
    }

    private static boolean isProviderSecretKey(String key) {
        return key.startsWith("vault:web:secret:");
    }

    private static String validateProvider(String provider) {
        if (!PROVIDERS.contains(provider)) throw new IllegalArgumentException("Unknown provider credential slot.");
        return provider;
    }

    private void putCredential(String provider, String secret) throws JSONException {
        if (secret.length() > 4096) throw new IllegalArgumentException("Provider credential is too long.");
        upsert("kv", new JSONObject().put("key", "vault:web:secret:" + validateProvider(provider)).put("value", secret));
    }

    /** Stores a provider key without returning it to the WebView. */
    public synchronized void setProviderCredential(String provider, String secret) throws Exception {
        validateProvider(provider);
        if (secret == null || secret.trim().isEmpty() || secret.length() > 4096 || hasControl(secret)) {
            throw new IllegalArgumentException("Provider credential is empty or invalid.");
        }
        putCredential(provider, secret.trim());
    }

    public synchronized String getProviderCredential(String provider) {
        String key = "vault:web:secret:" + validateProvider(provider);
        try (Cursor cursor = db.query("records", new String[]{"json"}, "store='kv' AND record_key=?", new String[]{key}, null, null, null)) {
            return cursor.moveToFirst() ? new JSONObject(cursor.getString(0)).optString("value", "") : "";
        } catch (JSONException e) {
            return "";
        }
    }

    public synchronized boolean hasProviderCredential(String provider) {
        return !getProviderCredential(provider).isEmpty();
    }

    public synchronized void removeProviderCredential(String provider) {
        db.delete("records", "store='kv' AND record_key=?", new String[]{"vault:web:secret:" + validateProvider(provider)});
    }

    private static boolean hasControl(String value) {
        for (int i = 0; i < value.length(); i++) if (value.charAt(i) < 32 || value.charAt(i) == 127) return true;
        return false;
    }

    private String metadata(String key) {
        try (Cursor cursor = db.query("metadata", new String[]{"value"}, "key=?", new String[]{key}, null, null, null)) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    private void setMetadata(String key, String value) {
        ContentValues row = new ContentValues();
        row.put("key", key);
        row.put("value", value);
        if (db.insertWithOnConflict("metadata", null, row, SQLiteDatabase.CONFLICT_REPLACE) < 0) {
            throw new IllegalStateException("Could not update owner data migration state.");
        }
    }

    @Override public synchronized void close() { db.close(); }
}
