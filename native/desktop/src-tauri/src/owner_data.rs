//! Encrypted owner application data on desktop using SQLCipher (`rusqlite` bundled SQLCipher
//! with OS Credential Manager key storage). Mirrors `OwnerDataDb.java` in schema and command API
//! so `src/store/db.ts` speaks one unified encrypted storage protocol on Android and Desktop.
//!
//! Security invariants:
//! - Every command goes through `require_owner_capability` BEFORE opening or querying SQLite.
//! - The 256-bit key lives only in the OS vault (`miss-minutes/owner-data` file-key slot) and zeroized memory.
//! - `vault:web:secret:*` and `vault:web:key` are isolated from SQLCipher `records` and never returned
//!   to WebView renderers. Plaintext string secrets encountered during legacy IndexedDB migration
//!   are moved directly into the native credential vault via `miss_minute_agent::secrets`.

use std::{fs, path::Path};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

const DB_NAME: &str = "miss-minutes-owner.db";
const SCHEMA_VERSION: i32 = 1;
const MAX_RECORD_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const MAX_BATCH_LEN: usize = 1000;

const STORES: &[&str] = &[
    "chats",
    "messages",
    "memories",
    "schedule",
    "todos",
    "timers",
    "notes",
    "activity",
    "kv",
    "missions",
    "offers",
    "calls",
    "delegations",
    "audit_chain",
    "connectors",
];

const PROVIDERS: &[&str] = &[
    "openai",
    "gemini",
    "anthropic",
    "openrouter",
    "ollama",
    "elevenlabs",
];

type SecretSink = Box<dyn Fn(&str, &str) -> Result<(), String> + Send>;

pub struct OwnerDataDb {
    conn: Connection,
    secret_sink: SecretSink,
}

impl OwnerDataDb {
    pub fn open(owner_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(owner_data_dir)
            .map_err(|e| format!("Cannot create owner data directory: {e}"))?;
        let key = miss_minute_agent::secrets::get_or_create_file_key("owner-data")
            .map_err(|e| format!("Cannot access OS-protected owner database key: {e:#}"))?;
        let path = owner_data_dir.join(DB_NAME);
        Self::open_with_key_and_sink(
            &path,
            key.as_slice(),
            Box::new(|provider, secret| {
                miss_minute_agent::secrets::set_provider_secret(provider, secret)
                    .map_err(|e| format!("Cannot import provider credential: {e:#}"))
            }),
        )
    }

    #[cfg(test)]
    pub(crate) fn open_with_key(path: &Path, key: &[u8]) -> Result<Self, String> {
        Self::open_with_key_and_sink(path, key, Box::new(|_, _| Ok(())))
    }

    pub(crate) fn open_with_key_and_sink(
        path: &Path,
        key: &[u8],
        secret_sink: SecretSink,
    ) -> Result<Self, String> {
        if key.len() != 32 {
            return Err("Owner database key has an invalid length.".to_owned());
        }
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create owner database directory: {e}"))?;
        }
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Refusing to open an owner database path that is a symbolic link.".into());
        }
        let conn = Connection::open(path)
            .map_err(|e| format!("Cannot open encrypted owner database: {e}"))?;
        let pragma = Zeroizing::new(format!(
            "PRAGMA key = \"x'{}'\"; PRAGMA cipher_memory_security = ON;",
            key_hex(key)
        ));
        conn.execute_batch(&pragma)
            .map_err(|e| format!("Cannot initialize SQLCipher key: {e}"))?;

        let cipher_version: String = conn
            .query_row("PRAGMA cipher_version", [], |row| row.get(0))
            .map_err(|_| "SQLCipher is not active; refusing plaintext owner data.".to_owned())?;
        if cipher_version.trim().is_empty() {
            return Err("SQLCipher is not active; refusing plaintext owner data.".to_owned());
        }

        let _: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))
            .map_err(|_| {
                "SQLCipher could not authenticate the encrypted owner database.".to_owned()
            })?;

        let _: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
            .map_err(|e| format!("Cannot enable WAL mode for owner database: {e}"))?;
        conn.execute_batch("PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;")
            .map_err(|e| format!("Cannot configure owner database durability: {e}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }

        let mut db = Self { conn, secret_sink };
        db.initialize()?;
        Ok(db)
    }

    pub fn is_write_op(request: &Value) -> bool {
        let op = request.get("op").and_then(Value::as_str).unwrap_or("");
        !matches!(
            op,
            "migrationStatus" | "list" | "get" | "messagesForChat" | "scheduleBetween"
        )
    }

    fn initialize(&mut self) -> Result<(), String> {
        let version: i32 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| format!("Cannot read owner database schema version: {e}"))?;
        if version > SCHEMA_VERSION {
            return Err("Owner database is newer than this app.".to_owned());
        }
        if version == SCHEMA_VERSION {
            return Ok(());
        }
        if version != 0 {
            return Err("Owner database migration is required.".to_owned());
        }

        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("Cannot initialize encrypted owner schema: {e}"))?;
        tx.execute_batch(
            "CREATE TABLE records(
                store TEXT NOT NULL,
                record_key TEXT NOT NULL,
                partition_key TEXT,
                sort_value REAL NOT NULL DEFAULT 0,
                json TEXT NOT NULL,
                PRIMARY KEY(store, record_key)
             );
             CREATE INDEX records_partition_idx ON records(store, partition_key, sort_value);
             CREATE INDEX records_sort_idx ON records(store, sort_value);
             CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = 1;",
        )
        .map_err(|e| format!("Cannot create encrypted owner tables: {e}"))?;
        tx.commit()
            .map_err(|e| format!("Cannot commit encrypted owner schema: {e}"))?;
        Ok(())
    }

    pub fn execute(&mut self, request: &Value) -> Result<Vec<Value>, String> {
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing owner data operation.".to_owned())?;
        let store = request.get("store").and_then(Value::as_str).unwrap_or("");

        match op {
            "migrationStatus" => {
                let done = self.metadata("legacy_idb_migrated")?.as_deref() == Some("1");
                Ok(vec![json!({ "done": done })])
            }
            "importBatch" => {
                let store = validate_store(store)?;
                let rows = request
                    .get("records")
                    .and_then(Value::as_array)
                    .filter(|arr| arr.len() <= MAX_BATCH_LEN)
                    .ok_or_else(|| "The migration batch is invalid.".to_owned())?;

                // Validate or import provider secrets before touching SQLite.
                let mut rows_to_write: Vec<&Map<String, Value>> = Vec::with_capacity(rows.len());
                for item in rows {
                    let obj = item
                        .as_object()
                        .ok_or_else(|| "The migration contains an invalid record.".to_owned())?;
                    if store == "kv" {
                        let key = obj.get("key").and_then(Value::as_str).unwrap_or("");
                        if key == "vault:web:key" {
                            // Browser WebCrypto key cannot cross into desktop; skip cleanly.
                            continue;
                        }
                        if let Some(provider) = key.strip_prefix("vault:web:secret:") {
                            validate_provider(provider)?;
                            if let Some(secret) = obj.get("value").and_then(Value::as_str) {
                                let trimmed = secret.trim();
                                if !trimmed.is_empty()
                                    && trimmed.len() <= 4096
                                    && !trimmed.bytes().any(|b| b < 32 || b == 127)
                                {
                                    (self.secret_sink)(provider, trimmed)?;
                                }
                            }
                            continue;
                        }
                    }
                    rows_to_write.push(obj);
                }

                let tx = self
                    .conn
                    .transaction()
                    .map_err(|e| format!("Cannot begin migration transaction: {e}"))?;
                for obj in rows_to_write {
                    upsert_tx(&tx, store, obj)?;
                }
                tx.commit()
                    .map_err(|e| format!("Cannot commit migration batch: {e}"))?;
                Ok(Vec::new())
            }
            "migrationComplete" => {
                self.set_metadata("legacy_idb_migrated", "1")?;
                Ok(Vec::new())
            }
            "list" => {
                let store = validate_store(store)?;
                let sql = if store == "kv" {
                    "SELECT json FROM records WHERE store=?1 AND record_key NOT LIKE 'vault:web:secret:%' AND record_key != 'vault:web:key' ORDER BY sort_value ASC"
                } else {
                    "SELECT json FROM records WHERE store=?1 ORDER BY sort_value ASC"
                };
                let mut stmt = self
                    .conn
                    .prepare(sql)
                    .map_err(|e| format!("Cannot prepare owner data query: {e}"))?;
                let mut rows = stmt
                    .query(params![store])
                    .map_err(|e| format!("Cannot execute owner data query: {e}"))?;
                collect_json_rows(&mut rows)
            }
            "messagesForChat" => {
                let chat_id = request.get("chatId").and_then(Value::as_str).unwrap_or("");
                let mut stmt = self
                    .conn
                    .prepare(
                        "SELECT json FROM records WHERE store='messages' AND partition_key=?1 ORDER BY sort_value ASC",
                    )
                    .map_err(|e| format!("Cannot prepare messages query: {e}"))?;
                let mut rows = stmt
                    .query(params![chat_id])
                    .map_err(|e| format!("Cannot execute messages query: {e}"))?;
                collect_json_rows(&mut rows)
            }
            "scheduleBetween" => {
                let from = request
                    .get("from")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| "Invalid schedule range start.".to_owned())?;
                let to = request
                    .get("to")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| "Invalid schedule range end.".to_owned())?;
                let mut stmt = self
                    .conn
                    .prepare(
                        "SELECT json FROM records WHERE store='schedule' AND sort_value>=?1 AND sort_value<?2 ORDER BY sort_value ASC",
                    )
                    .map_err(|e| format!("Cannot prepare schedule query: {e}"))?;
                let mut rows = stmt
                    .query(params![from, to])
                    .map_err(|e| format!("Cannot execute schedule query: {e}"))?;
                collect_json_rows(&mut rows)
            }
            "get" => {
                let store = validate_store(store)?;
                let key = request.get("key").and_then(Value::as_str).unwrap_or("");
                if store == "kv" && is_secret_kv_key(key) {
                    return Err(
                        "Provider credentials are available only to the native credential service."
                            .to_owned(),
                    );
                }
                let row: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT json FROM records WHERE store=?1 AND record_key=?2",
                        params![store, key],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| format!("Cannot read owner record: {e}"))?;
                match row {
                    Some(text) => {
                        if text.len() > MAX_RESPONSE_BYTES {
                            return Err(
                                "The requested owner data record is too large to return safely."
                                    .to_owned(),
                            );
                        }
                        let parsed = serde_json::from_str::<Value>(&text)
                            .map_err(|e| format!("Stored owner record is corrupt JSON: {e}"))?;
                        Ok(vec![parsed])
                    }
                    None => Ok(Vec::new()),
                }
            }
            "put" => {
                let store = validate_store(store)?;
                let obj = require_record(request)?;
                if store == "kv" {
                    let key = record_key(store, obj)?;
                    if is_secret_kv_key(&key) {
                        return Err(
                            "Provider credentials must use the native credential service."
                                .to_owned(),
                        );
                    }
                }
                let tx = self
                    .conn
                    .transaction()
                    .map_err(|e| format!("Cannot begin write transaction: {e}"))?;
                upsert_tx(&tx, store, obj)?;
                tx.commit()
                    .map_err(|e| format!("Cannot commit encrypted owner write: {e}"))?;
                Ok(Vec::new())
            }
            "putMany" => {
                let store = validate_store(store)?;
                let rows = request
                    .get("records")
                    .and_then(Value::as_array)
                    .filter(|arr| arr.len() <= MAX_BATCH_LEN)
                    .ok_or_else(|| "The record batch is invalid.".to_owned())?;
                let tx = self
                    .conn
                    .transaction()
                    .map_err(|e| format!("Cannot begin batch transaction: {e}"))?;
                for item in rows {
                    let obj = item
                        .as_object()
                        .ok_or_else(|| "The record batch contains an invalid entry.".to_owned())?;
                    if store == "kv" {
                        let key = record_key(store, obj)?;
                        if is_secret_kv_key(&key) {
                            return Err(
                                "Provider credentials must use the native credential service."
                                    .to_owned(),
                            );
                        }
                    }
                    upsert_tx(&tx, store, obj)?;
                }
                tx.commit()
                    .map_err(|e| format!("Cannot commit batch write: {e}"))?;
                Ok(Vec::new())
            }
            "delete" => {
                let store = validate_store(store)?;
                let key = request.get("key").and_then(Value::as_str).unwrap_or("");
                self.conn
                    .execute(
                        "DELETE FROM records WHERE store=?1 AND record_key=?2",
                        params![store, key],
                    )
                    .map_err(|e| format!("Cannot delete owner record: {e}"))?;
                Ok(Vec::new())
            }
            "clear" => {
                let store = validate_store(store)?;
                self.conn
                    .execute("DELETE FROM records WHERE store=?1", params![store])
                    .map_err(|e| format!("Cannot clear owner store: {e}"))?;
                Ok(Vec::new())
            }
            "saveMessage" => {
                let message = require_record(request)?;
                let tx = self
                    .conn
                    .transaction()
                    .map_err(|e| format!("Cannot begin message transaction: {e}"))?;
                upsert_tx(&tx, "messages", message)?;
                let chat_id = message.get("chatId").and_then(Value::as_str).unwrap_or("");
                let existing_chat: Option<String> = tx
                    .query_row(
                        "SELECT json FROM records WHERE store='chats' AND record_key=?1",
                        params![chat_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| format!("Cannot inspect chat metadata: {e}"))?;
                if let Some(chat_json) = existing_chat
                    && let Ok(Value::Object(mut chat)) = serde_json::from_str::<Value>(&chat_json)
                {
                    let current_updated =
                        chat.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
                    let msg_created = message
                        .get("createdAt")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    chat.insert("updatedAt".into(), json!(current_updated.max(msg_created)));
                    upsert_tx(&tx, "chats", &chat)?;
                }
                tx.commit()
                    .map_err(|e| format!("Cannot save encrypted message: {e}"))?;
                Ok(Vec::new())
            }
            "deleteChat" => {
                let chat_id = request.get("chatId").and_then(Value::as_str).unwrap_or("");
                let tx = self
                    .conn
                    .transaction()
                    .map_err(|e| format!("Cannot begin chat deletion transaction: {e}"))?;
                tx.execute(
                    "DELETE FROM records WHERE store='messages' AND partition_key=?1",
                    params![chat_id],
                )
                .map_err(|e| format!("Cannot delete chat messages: {e}"))?;
                tx.execute(
                    "DELETE FROM records WHERE store='chats' AND record_key=?1",
                    params![chat_id],
                )
                .map_err(|e| format!("Cannot delete chat header: {e}"))?;
                tx.commit()
                    .map_err(|e| format!("Cannot commit chat deletion: {e}"))?;
                Ok(Vec::new())
            }
            "logActivity" => {
                let record = require_record(request)?;
                let tx = self
                    .conn
                    .transaction()
                    .map_err(|e| format!("Cannot begin activity transaction: {e}"))?;
                upsert_tx(&tx, "activity", record)?;
                tx.execute(
                    "DELETE FROM records WHERE store='activity' AND record_key NOT IN (SELECT record_key FROM records WHERE store='activity' ORDER BY sort_value DESC LIMIT 500)",
                    [],
                )
                .map_err(|e| format!("Cannot prune activity log: {e}"))?;
                tx.commit()
                    .map_err(|e| format!("Cannot commit activity entry: {e}"))?;
                Ok(Vec::new())
            }
            "wipe" => {
                let tx = self
                    .conn
                    .transaction()
                    .map_err(|e| format!("Cannot begin wipe transaction: {e}"))?;
                tx.execute("DELETE FROM records", [])
                    .map_err(|e| format!("Cannot wipe owner records: {e}"))?;
                tx.execute("DELETE FROM metadata", [])
                    .map_err(|e| format!("Cannot wipe owner metadata: {e}"))?;
                tx.commit()
                    .map_err(|e| format!("Cannot commit owner wipe: {e}"))?;
                Ok(Vec::new())
            }
            _ => Err("Unsupported owner data operation.".to_owned()),
        }
    }

    fn metadata(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM metadata WHERE key=?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("Cannot read owner metadata: {e}"))
    }

    fn set_metadata(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO metadata(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|e| format!("Cannot update owner migration state: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
pub fn owner_data(
    request: Value,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::DesktopState>,
) -> Result<Value, String> {
    let capability = if OwnerDataDb::is_write_op(&request) {
        miss_minute_identity::capabilities::PRIVATE_MEMORY_WRITE
    } else {
        miss_minute_identity::capabilities::PRIVATE_MEMORY_READ
    };
    crate::require_owner_capability(&window, capability)?;

    let mut guard = state
        .owner_db
        .lock()
        .map_err(|_| "Encrypted owner database state is unavailable.".to_owned())?;
    if guard.is_none() {
        let dir = state.owner_data_dir.clone();
        *guard = Some(OwnerDataDb::open(&dir)?);
    }
    let db = guard
        .as_mut()
        .ok_or_else(|| "Encrypted owner database is unavailable.".to_owned())?;
    let rows = db.execute(&request)?;
    Ok(json!({ "data": rows }))
}

fn key_hex(key: &[u8]) -> String {
    key.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validate_store(store: &str) -> Result<&str, String> {
    if STORES.contains(&store) {
        Ok(store)
    } else {
        Err("Unknown owner data store.".to_owned())
    }
}

fn validate_provider(provider: &str) -> Result<&str, String> {
    if PROVIDERS.contains(&provider) {
        Ok(provider)
    } else {
        Err("Unknown provider credential slot.".to_owned())
    }
}

fn is_secret_kv_key(key: &str) -> bool {
    key.starts_with("vault:web:secret:") || key == "vault:web:key"
}

fn require_record(request: &Value) -> Result<&Map<String, Value>, String> {
    request
        .get("record")
        .and_then(Value::as_object)
        .ok_or_else(|| "The owner data record is missing.".to_owned())
}

fn record_key(store: &str, value: &Map<String, Value>) -> Result<String, String> {
    let field = if store == "kv" { "key" } else { "id" };
    let key = value.get(field).and_then(Value::as_str).unwrap_or("");
    if key.is_empty() || key.len() > 256 || key.contains('\0') {
        return Err("The record key is invalid.".to_owned());
    }
    Ok(key.to_owned())
}

fn opt_finite_number(value: &Map<String, Value>, field: &str) -> Option<f64> {
    value
        .get(field)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn upsert_tx(tx: &Transaction<'_>, store: &str, value: &Map<String, Value>) -> Result<(), String> {
    let key = record_key(store, value)?;
    let partition_key = if store == "messages" {
        Some(
            value
                .get("chatId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        )
    } else {
        None
    };
    let sort_value = if store == "schedule" {
        opt_finite_number(value, "startAt").unwrap_or(0.0)
    } else if store == "activity" {
        opt_finite_number(value, "at").unwrap_or(0.0)
    } else {
        opt_finite_number(value, "updatedAt")
            .or_else(|| opt_finite_number(value, "createdAt"))
            .unwrap_or(0.0)
    };
    let json = serde_json::to_string(value)
        .map_err(|e| format!("Cannot serialize owner data record: {e}"))?;
    if json.len() > MAX_RECORD_BYTES {
        return Err("The owner data record is too large.".to_owned());
    }
    tx.execute(
        "INSERT INTO records(store, record_key, partition_key, sort_value, json)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(store, record_key) DO UPDATE SET
           partition_key=excluded.partition_key,
           sort_value=excluded.sort_value,
           json=excluded.json",
        params![store, key, partition_key, sort_value, json],
    )
    .map_err(|e| format!("Cannot persist encrypted owner data: {e}"))?;
    Ok(())
}

fn collect_json_rows(rows: &mut rusqlite::Rows<'_>) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut total_bytes: usize = 0;
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("Cannot read owner query row: {e}"))?
    {
        let text: String = row
            .get(0)
            .map_err(|e| format!("Cannot decode owner query row: {e}"))?;
        total_bytes = total_bytes.saturating_add(text.len());
        if total_bytes > MAX_RESPONSE_BYTES {
            return Err("The requested owner data set is too large to return safely.".to_owned());
        }
        let parsed = serde_json::from_str::<Value>(&text)
            .map_err(|e| format!("Stored owner record is corrupt JSON: {e}"))?;
        out.push(parsed);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    fn test_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "miss-minutes-owner-data-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn encrypted_at_rest_and_wrong_key_rejected() {
        let dir = test_dir("enc");
        let db_path = dir.join(DB_NAME);
        let key_a = [0x11_u8; 32];
        let key_b = [0x22_u8; 32];

        {
            let mut db = OwnerDataDb::open_with_key(&db_path, &key_a).unwrap();
            db.execute(&json!({
                "op": "put",
                "store": "memories",
                "record": {
                    "id": "mem-1",
                    "text": "Owner super secret timeline entry 42",
                    "createdAt": 100
                }
            }))
            .unwrap();
        }

        let raw_bytes = fs::read(&db_path).unwrap();
        let needle = b"Owner super secret timeline entry 42";
        assert!(
            !raw_bytes.windows(needle.len()).any(|w| w == needle),
            "plaintext marker must never appear in encrypted SQLCipher database file"
        );

        let wrong_open = OwnerDataDb::open_with_key(&db_path, &key_b);
        assert!(
            wrong_open.is_err(),
            "opening SQLCipher DB with wrong key must fail"
        );

        let mut reopened = OwnerDataDb::open_with_key(&db_path, &key_a).unwrap();
        let rows = reopened
            .execute(&json!({
                "op": "get",
                "store": "memories",
                "key": "mem-1"
            }))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].get("text").and_then(Value::as_str),
            Some("Owner super secret timeline entry 42")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn crud_messages_schedule_activity_and_wipe_work() {
        let dir = test_dir("crud");
        let db_path = dir.join(DB_NAME);
        let key = [0x33_u8; 32];
        let mut db = OwnerDataDb::open_with_key(&db_path, &key).unwrap();

        assert_eq!(
            db.execute(&json!({ "op": "migrationStatus" })).unwrap(),
            vec![json!({ "done": false })]
        );
        db.execute(&json!({ "op": "migrationComplete" })).unwrap();
        assert_eq!(
            db.execute(&json!({ "op": "migrationStatus" })).unwrap(),
            vec![json!({ "done": true })]
        );

        db.execute(&json!({
            "op": "put",
            "store": "chats",
            "record": { "id": "c1", "title": "Chat 1", "createdAt": 100, "updatedAt": 100 }
        }))
        .unwrap();
        db.execute(&json!({
            "op": "saveMessage",
            "record": { "id": "m1", "chatId": "c1", "sender": "user", "text": "hello", "createdAt": 250 }
        }))
        .unwrap();

        let chat = db
            .execute(&json!({ "op": "get", "store": "chats", "key": "c1" }))
            .unwrap();
        assert_eq!(chat[0].get("updatedAt").and_then(Value::as_i64), Some(250));

        let msgs = db
            .execute(&json!({ "op": "messagesForChat", "chatId": "c1" }))
            .unwrap();
        assert_eq!(msgs.len(), 1);

        db.execute(&json!({
            "op": "putMany",
            "store": "schedule",
            "records": [
                { "id": "s1", "kind": "event", "title": "Morning", "startAt": 1000, "createdAt": 1 },
                { "id": "s2", "kind": "event", "title": "Later", "startAt": 5000, "createdAt": 2 }
            ]
        }))
        .unwrap();
        let between = db
            .execute(&json!({ "op": "scheduleBetween", "from": 500, "to": 2000 }))
            .unwrap();
        assert_eq!(between.len(), 1);
        assert_eq!(between[0].get("id").and_then(Value::as_str), Some("s1"));

        for i in 0..520 {
            db.execute(&json!({
                "op": "logActivity",
                "record": { "id": format!("act-{i}"), "at": i + 1, "kind": "note", "summary": "tick" }
            }))
            .unwrap();
        }
        let acts = db
            .execute(&json!({ "op": "list", "store": "activity" }))
            .unwrap();
        assert_eq!(acts.len(), 500);
        assert_eq!(acts[0].get("at").and_then(Value::as_i64), Some(21));

        db.execute(&json!({ "op": "deleteChat", "chatId": "c1" }))
            .unwrap();
        assert!(
            db.execute(&json!({ "op": "messagesForChat", "chatId": "c1" }))
                .unwrap()
                .is_empty()
        );
        assert!(
            db.execute(&json!({ "op": "get", "store": "chats", "key": "c1" }))
                .unwrap()
                .is_empty()
        );

        db.execute(&json!({ "op": "wipe" })).unwrap();
        assert_eq!(
            db.execute(&json!({ "op": "migrationStatus" })).unwrap(),
            vec![json!({ "done": false })]
        );
        assert!(
            db.execute(&json!({ "op": "list", "store": "schedule" }))
                .unwrap()
                .is_empty()
        );
        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn provider_secrets_isolated_from_records() {
        let dir = test_dir("secrets");
        let db_path = dir.join(DB_NAME);
        let key = [0x44_u8; 32];
        let captured = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let sink_captured = Arc::clone(&captured);
        let mut db = OwnerDataDb::open_with_key_and_sink(
            &db_path,
            &key,
            Box::new(move |provider, secret| {
                sink_captured
                    .lock()
                    .unwrap()
                    .push((provider.to_owned(), secret.to_owned()));
                Ok(())
            }),
        )
        .unwrap();

        assert!(
            db.execute(&json!({
                "op": "put",
                "store": "kv",
                "record": { "key": "vault:web:secret:openai", "value": "sk-bad" }
            }))
            .is_err()
        );
        assert!(
            db.execute(&json!({
                "op": "put",
                "store": "kv",
                "record": { "key": "vault:web:key", "value": "bad" }
            }))
            .is_err()
        );
        assert!(
            db.execute(&json!({
                "op": "get",
                "store": "kv",
                "key": "vault:web:secret:openai"
            }))
            .is_err()
        );
        assert!(
            db.execute(&json!({
                "op": "get",
                "store": "kv",
                "key": "vault:web:key"
            }))
            .is_err()
        );

        db.execute(&json!({
            "op": "importBatch",
            "store": "kv",
            "records": [
                { "key": "vault:web:key", "value": { "wrapped": true } },
                { "key": "vault:web:secret:openai", "value": "sk-migrated-secret" },
                { "key": "vault:web:secret:gemini", "value": { "v": 1 } },
                { "key": "ui:theme", "value": "tva" }
            ]
        }))
        .unwrap();

        let sink_items = captured.lock().unwrap().clone();
        assert_eq!(
            sink_items,
            vec![("openai".to_owned(), "sk-migrated-secret".to_owned())]
        );

        let listed = db.execute(&json!({ "op": "list", "store": "kv" })).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].get("key").and_then(Value::as_str),
            Some("ui:theme")
        );

        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extended_stores_persist_and_unknown_store_rejected() {
        let dir = test_dir("ext-stores");
        let db_path = dir.join(DB_NAME);
        let key = [0x55_u8; 32];
        let mut db = OwnerDataDb::open_with_key(&db_path, &key).unwrap();

        for store in [
            "missions",
            "offers",
            "calls",
            "delegations",
            "audit_chain",
            "connectors",
        ] {
            let record_id = format!("{store}-item-1");
            db.execute(&json!({
                "op": "put",
                "store": store,
                "record": { "id": record_id, "createdAt": 42, "label": store }
            }))
            .unwrap();
            let fetched = db
                .execute(&json!({
                    "op": "get",
                    "store": store,
                    "key": format!("{store}-item-1")
                }))
                .unwrap();
            assert_eq!(fetched.len(), 1);
            assert_eq!(fetched[0].get("label").and_then(Value::as_str), Some(store));
        }

        assert!(
            db.execute(&json!({
                "op": "list",
                "store": "rogue_unlisted_store"
            }))
            .is_err()
        );

        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }
}
