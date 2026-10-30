use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
};

use fs2::FileExt;
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::config::now_unix_ms;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventRecord {
    pub seq: i64,
    pub id: String,
    pub source: String,
    pub event_type: String,
    pub observed_at_unix_ms: i64,
    pub source_timestamp_unix_ms: Option<i64>,
    pub timestamp_semantics: String,
    pub resource_path: Option<String>,
    pub payload_json: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DecisionRecord {
    pub id: String,
    pub through_seq: i64,
    pub created_at_unix_ms: i64,
    pub decision_json: String,
}


#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerContextRecord {
    pub id: String,
    pub title: String,
    pub content: String,
    pub enabled: bool,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingActionRecord {
    pub id: String,
    pub through_seq: i64,
    pub description: String,
    pub payload_json: String,
    pub evidence_event_ids_json: String,
    pub status: String,
    pub created_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
    pub result_json: Option<String>,
}


fn key_hex(key: &[u8]) -> String {
    key.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn open_encrypted_connection(path: &Path, key: &[u8]) -> Result<Connection> {
    let connection = Connection::open(path)
        .with_context(|| format!("Cannot open encrypted database {}", path.display()))?;
    let pragma = format!("PRAGMA key = \"x'{}'\"; PRAGMA cipher_memory_security = ON;", key_hex(key));
    connection.execute_batch(&pragma).context("Cannot initialize SQLCipher key")?;
    let _: i64 = connection.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))
        .context("SQLCipher could not authenticate the local event database. The key is missing, incorrect, or the file is damaged.")?;
    Ok(connection)
}

fn is_plaintext_database(path: &Path) -> Result<bool> {
    let connection = Connection::open(path)
        .with_context(|| format!("Cannot inspect local database {}", path.display()))?;
    Ok(connection.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get::<_, i64>(0)).is_ok())
}

fn sql_literal_path(path: &Path) -> Result<String> {
    let value = path.to_str().context("Database migration path is not valid UTF-8")?;
    Ok(value.replace('\'', "''"))
}

fn migrate_plaintext_database(path: &Path, key: &[u8]) -> Result<()> {
    let (temporary, backup) = crate::secrets::migration_paths(path);
    if backup.exists() {
        bail!("An interrupted database migration backup exists at {}. Refusing to overwrite or delete it; recover it manually first.", backup.display());
    }
    if temporary.exists() {
        fs::remove_file(&temporary)
            .with_context(|| format!("Cannot remove stale migration file {}", temporary.display()))?;
    }

    let source = Connection::open(path)
        .with_context(|| format!("Cannot open legacy plaintext database {}", path.display()))?;
    source.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
        .context("Cannot checkpoint legacy database before encryption")?;
    let attach = format!(
        "ATTACH DATABASE '{}' AS encrypted KEY \"x'{}'\"; SELECT sqlcipher_export('encrypted'); DETACH DATABASE encrypted;",
        sql_literal_path(&temporary)?,
        key_hex(key)
    );
    let export_result = source.execute_batch(&attach)
        .context("SQLCipher failed to export the legacy plaintext database");
    drop(source);
    export_result?;

    let verified = open_encrypted_connection(&temporary, key)
        .context("Encrypted migration output failed verification; plaintext source was preserved")?;
    drop(verified);

    fs::rename(path, &backup)
        .with_context(|| format!("Cannot preserve the legacy database at {}", backup.display()))?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::rename(&backup, path);
        return Err(error).with_context(|| format!("Cannot install encrypted database at {}", path.display()));
    }
    fs::remove_file(&backup)
        .with_context(|| format!("Encrypted database is installed, but plaintext backup remains at {}", backup.display()))?;
    Ok(())
}

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
            fs::create_dir_all(parent)
                .with_context(|| format!("Cannot create database directory {}", parent.display()))?;
        }
        if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            bail!("Refusing to open a database path that is a symbolic link.");
        }

        let mut lock_path_value = path.as_os_str().to_os_string();
        lock_path_value.push(".key-lock");
        let lock_path = PathBuf::from(lock_path_value);
        let lock_file = OpenOptions::new().create(true).read(true).write(true).open(&lock_path)
            .with_context(|| format!("Cannot open database setup lock {}", lock_path.display()))?;
        FileExt::lock_exclusive(&lock_file).context("Cannot acquire database setup lock")?;

        let mut key = crate::secrets::existing_database_key(path)?;
        let (temporary, backup) = crate::secrets::migration_paths(path);
        if backup.exists() {
            if !path.exists() {
                fs::rename(&backup, path)
                    .context("Restored the legacy database after an interrupted encryption migration")?;
            } else {
                let current_key = key.as_ref().context(
                    "An encryption migration backup exists but the operating-system database key is missing."
                )?;
                if open_encrypted_connection(path, current_key.as_slice()).is_ok() {
                    fs::remove_file(&backup)
                        .context("Encrypted database is valid but the old plaintext backup could not be removed")?;
                } else {
                    bail!("Both a database and a plaintext migration backup exist, but the database cannot be authenticated. Preserving both files for manual recovery.");
                }
            }
        }
        if temporary.exists() {
            fs::remove_file(&temporary)
                .context("Cannot remove an incomplete encrypted migration staging file")?;
        }

        let exists = path.is_file() && fs::metadata(path)?.len() > 0;
        let plaintext = if exists { is_plaintext_database(path)? } else { false };

        if exists && !plaintext && key.is_none() {
            bail!("An encrypted database exists but its operating-system key is missing. Refusing to replace the key or initialize a new database.");
        }
        if key.is_none() {
            key = Some(crate::secrets::create_database_key(path)?);
        }
        let key = key.context("Database key initialization failed")?;

        if exists && plaintext {
            migrate_plaintext_database(path, key.as_slice())?;
        }

        let connection = open_encrypted_connection(path, key.as_slice())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .with_context(|| format!("Cannot restrict database permissions: {}", path.display()))?;
        }

        let store = Self::initialize(connection)?;
        drop(lock_file);
        Ok(store)
    }

    #[cfg(test)]
    pub(crate) fn open_for_tests(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        let connection = open_encrypted_connection(path, &[0x42_u8; 32])?;
        Self::initialize(connection)
    }

    #[cfg(test)]
    fn open_memory() -> Result<Self> {
        Self::initialize(Connection::open_in_memory()?)
    }

    fn initialize(connection: Connection) -> Result<Self> {
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA secure_delete=ON;
             PRAGMA cipher_memory_security=ON;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS events (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 id TEXT NOT NULL UNIQUE,
                 source TEXT NOT NULL,
                 event_type TEXT NOT NULL,
                 observed_at_unix_ms INTEGER NOT NULL,
                 source_timestamp_unix_ms INTEGER,
                 timestamp_semantics TEXT NOT NULL,
                 resource_path TEXT,
                 payload_json TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS events_observed_idx ON events(observed_at_unix_ms DESC);
             CREATE INDEX IF NOT EXISTS events_path_idx ON events(resource_path);
             CREATE TABLE IF NOT EXISTS resources (
                 path TEXT PRIMARY KEY,
                 root_path TEXT NOT NULL,
                 size_bytes INTEGER NOT NULL,
                 modified_at_unix_ms INTEGER,
                 active INTEGER NOT NULL,
                 last_observed_at_unix_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS resources_root_idx ON resources(root_path);
             CREATE TABLE IF NOT EXISTS decisions (
                 id TEXT PRIMARY KEY,
                 through_seq INTEGER NOT NULL,
                 created_at_unix_ms INTEGER NOT NULL,
                 decision_json TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS decisions_created_idx ON decisions(created_at_unix_ms DESC);
             CREATE TABLE IF NOT EXISTS action_queue (
                 id TEXT PRIMARY KEY,
                 through_seq INTEGER NOT NULL UNIQUE,
                 description TEXT NOT NULL,
                 payload_json TEXT NOT NULL,
                 evidence_event_ids_json TEXT NOT NULL,
                 status TEXT NOT NULL CHECK(status IN ('pending','executing','succeeded','failed','rejected','expired')),
                 created_at_unix_ms INTEGER NOT NULL,
                 expires_at_unix_ms INTEGER NOT NULL,
                 approved_at_unix_ms INTEGER,
                 completed_at_unix_ms INTEGER,
                 result_json TEXT
             );
             CREATE INDEX IF NOT EXISTS action_queue_pending_idx ON action_queue(status, created_at_unix_ms DESC);
             CREATE TABLE IF NOT EXISTS action_audit (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 action_id TEXT NOT NULL,
                 event_type TEXT NOT NULL,
                 occurred_at_unix_ms INTEGER NOT NULL,
                 payload_json TEXT NOT NULL,
                 FOREIGN KEY(action_id) REFERENCES action_queue(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS action_audit_action_idx ON action_audit(action_id, seq);
             CREATE TABLE IF NOT EXISTS owner_contexts (
                 id TEXT PRIMARY KEY,
                 title TEXT NOT NULL,
                 content TEXT NOT NULL,
                 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
                 created_at_unix_ms INTEGER NOT NULL,
                 updated_at_unix_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS owner_contexts_updated_idx ON owner_contexts(updated_at_unix_ms DESC);",
        )?;
        Ok(Self { connection })
    }


    pub fn owner_contexts(&self) -> Result<Vec<OwnerContextRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, content, enabled, created_at_unix_ms, updated_at_unix_ms
             FROM owner_contexts ORDER BY updated_at_unix_ms DESC LIMIT 20"
        )?;
        let rows = statement.query_map([], |row| {
            Ok(OwnerContextRecord {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                created_at_unix_ms: row.get(4)?,
                updated_at_unix_ms: row.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    pub fn enabled_owner_contexts(&self) -> Result<Vec<OwnerContextRecord>> {
        Ok(self.owner_contexts()?.into_iter().filter(|context| context.enabled).collect())
    }

    pub fn upsert_owner_context(
        &mut self,
        id: Option<&str>,
        title: &str,
        content: &str,
        enabled: bool,
    ) -> Result<OwnerContextRecord> {
        let title = title.trim();
        if title.is_empty() || title.len() > 80 || title.contains('\0') {
            bail!("Context title must contain 1 to 80 bytes and no NUL.");
        }
        if content.trim().is_empty() || content.len() > 16 * 1024 || content.contains('\0') {
            bail!("Context content must contain 1 to 16384 bytes and no NUL.");
        }

        let id = id.map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
        let existing_len: i64 = self.connection.query_row(
            "SELECT length(CAST(content AS BLOB)) FROM owner_contexts WHERE id=?1",
            [&id],
            |row| row.get(0),
        ).optional()?.unwrap_or(0);
        let total_len: i64 = self.connection.query_row(
            "SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) FROM owner_contexts",
            [],
            |row| row.get(0),
        )?;
        if total_len - existing_len + content.len() as i64 > 64 * 1024 {
            bail!("Owner-pinned context exceeds the 64 KiB aggregate storage limit.");
        }
        let count: i64 = self.connection.query_row("SELECT COUNT(*) FROM owner_contexts", [], |row| row.get(0))?;
        if existing_len == 0 && count >= 20 {
            bail!("At most 20 owner-pinned context notes are allowed.");
        }

        let now = now_unix_ms();
        self.connection.execute(
            "INSERT INTO owner_contexts (id,title,content,enabled,created_at_unix_ms,updated_at_unix_ms)
             VALUES (?1,?2,?3,?4,?5,?5)
             ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, content=excluded.content,
                 enabled=excluded.enabled, updated_at_unix_ms=excluded.updated_at_unix_ms",
            params![id, title, content, i64::from(enabled), now],
        )?;
        self.append_event(
            "owner_context",
            "owner.context_saved",
            None,
            "agent_observed_at",
            None,
            &serde_json::json!({"id": id, "title": title, "enabled": enabled, "content_bytes": content.len()}),
        )?;
        self.owner_contexts()?.into_iter().find(|context| context.id == id)
            .context("Saved owner context could not be read back")
    }

    pub fn delete_owner_context(&mut self, id: &str) -> Result<bool> {
        let changed = self.connection.execute("DELETE FROM owner_contexts WHERE id=?1", [id])? > 0;
        if changed {
            self.append_event(
                "owner_context",
                "owner.context_deleted",
                None,
                "agent_observed_at",
                None,
                &serde_json::json!({"id": id}),
            )?;
        }
        Ok(changed)
    }

    pub fn append_event(
        &mut self,
        source: &str,
        event_type: &str,
        source_timestamp_unix_ms: Option<i64>,
        timestamp_semantics: &str,
        resource_path: Option<&str>,
        payload: &Value,
    ) -> Result<i64> {
        let id = Uuid::new_v4().to_string();
        let observed_at = now_unix_ms();
        let payload_json = serde_json::to_string(payload)?;

        self.connection.execute(
            "INSERT INTO events (
                id, source, event_type, observed_at_unix_ms,
                source_timestamp_unix_ms, timestamp_semantics,
                resource_path, payload_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id, source, event_type, observed_at, source_timestamp_unix_ms,
                timestamp_semantics, resource_path, payload_json
            ],
        )?;
        Ok(self.connection.last_insert_rowid())
    }

    /// Stores file metadata only. This method never opens or reads file contents.
    /// Returns 1 for discovery, 2 for metadata change, and 0 when unchanged.
    pub fn observe_file(
        &mut self,
        root_path: &str,
        resource_path: &str,
        size_bytes: u64,
        modified_at_unix_ms: Option<i64>,
        source: &str,
    ) -> Result<u8> {
        let previous: Option<(i64, Option<i64>, i64)> = self.connection
            .query_row(
                "SELECT size_bytes, modified_at_unix_ms, active FROM resources WHERE path = ?1",
                [resource_path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        let size = size_bytes.min(i64::MAX as u64) as i64;
        let state = match previous {
            None => 1,
            Some((old_size, old_modified, active))
                if old_size != size || old_modified != modified_at_unix_ms || active == 0 => 2,
            Some(_) => 0,
        };

        self.connection.execute(
            "INSERT INTO resources (
                path, root_path, size_bytes, modified_at_unix_ms, active, last_observed_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, 1, ?5)
             ON CONFLICT(path) DO UPDATE SET
                root_path = excluded.root_path,
                size_bytes = excluded.size_bytes,
                modified_at_unix_ms = excluded.modified_at_unix_ms,
                active = 1,
                last_observed_at_unix_ms = excluded.last_observed_at_unix_ms",
            params![resource_path, root_path, size, modified_at_unix_ms, now_unix_ms()],
        )?;

        if state != 0 {
            let event_type = if state == 1 {
                "filesystem.resource_discovered"
            } else {
                "filesystem.metadata_changed"
            };
            let payload = serde_json::json!({
                "root_path": root_path,
                "size_bytes": size,
                "is_regular_file": true,
                "modified_at_unix_ms": modified_at_unix_ms,
                "timestamp_warning": "Filesystem modification time is metadata, not proof of creation time or user activity.",
                "content_read": false
            });
            self.append_event(
                source,
                event_type,
                modified_at_unix_ms,
                "filesystem_metadata_mtime_not_creation_time",
                Some(resource_path),
                &payload,
            )?;
        }
        Ok(state)
    }

    pub fn record_notification(
        &mut self,
        event_kind: &str,
        resource_path: &str,
        metadata: Option<(u64, Option<i64>)>,
    ) -> Result<i64> {
        let (size_bytes, modified_at) = metadata
            .map(|(size, modified)| (Some(size), modified))
            .unwrap_or((None, None));
        let payload = serde_json::json!({
            "notification_kind": event_kind,
            "size_bytes": size_bytes,
            "modified_at_unix_ms": modified_at,
            "content_read": false,
            "semantics": "Operating-system file notification observed by this process; not proof that a person opened or edited the file."
        });
        self.append_event(
            "filesystem_watcher",
            "filesystem.notification",
            modified_at,
            if modified_at.is_some() { "filesystem_metadata_mtime_not_creation_time" } else { "agent_observed_at" },
            Some(resource_path),
            &payload,
        )
    }

    pub fn mark_resource_inactive(&mut self, path: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE resources SET active = 0, last_observed_at_unix_ms = ?2 WHERE path = ?1",
            params![path, now_unix_ms()],
        )?;
        Ok(())
    }

    pub fn last_event_sequence(&self) -> Result<i64> {
        self.connection.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM events",
            [],
            |row| row.get(0),
        ).context("Cannot read the current event cursor")
    }

    pub fn events_after(&self, sequence: i64, limit: usize) -> Result<Vec<EventRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT seq, id, source, event_type, observed_at_unix_ms,
                    source_timestamp_unix_ms, timestamp_semantics, resource_path, payload_json
             FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![sequence, limit.min(500) as i64], |row| {
            Ok(EventRecord {
                seq: row.get(0)?,
                id: row.get(1)?,
                source: row.get(2)?,
                event_type: row.get(3)?,
                observed_at_unix_ms: row.get(4)?,
                source_timestamp_unix_ms: row.get(5)?,
                timestamp_semantics: row.get(6)?,
                resource_path: row.get(7)?,
                payload_json: row.get(8)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().context("Cannot read local evidence events")
    }

    pub fn recent_events(&self, limit: usize) -> Result<Vec<EventRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT seq, id, source, event_type, observed_at_unix_ms,
                    source_timestamp_unix_ms, timestamp_semantics, resource_path, payload_json
             FROM events ORDER BY seq DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.min(200) as i64], |row| {
            Ok(EventRecord {
                seq: row.get(0)?,
                id: row.get(1)?,
                source: row.get(2)?,
                event_type: row.get(3)?,
                observed_at_unix_ms: row.get(4)?,
                source_timestamp_unix_ms: row.get(5)?,
                timestamp_semantics: row.get(6)?,
                resource_path: row.get(7)?,
                payload_json: row.get(8)?,
            })
        })?;
        let mut events = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        events.reverse();
        Ok(events)
    }

    pub fn last_decision_sequence(&self) -> Result<i64> {
        self.connection.query_row(
            "SELECT COALESCE(MAX(through_seq), 0) FROM decisions",
            [],
            |row| row.get(0),
        ).context("Cannot read reasoning cursor")
    }

    pub fn record_decision(&mut self, through_seq: i64, decision: &Value) -> Result<()> {
        self.connection.execute(
            "INSERT INTO decisions (id, through_seq, created_at_unix_ms, decision_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                Uuid::new_v4().to_string(),
                through_seq,
                now_unix_ms(),
                serde_json::to_string(decision)?
            ],
        )?;
        Ok(())
    }

    fn audit_action(
        tx: &rusqlite::Transaction<'_>,
        action_id: &str,
        event_type: &str,
        payload: &Value,
    ) -> Result<()> {
        tx.execute(
            "INSERT INTO action_audit (action_id, event_type, occurred_at_unix_ms, payload_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![action_id, event_type, now_unix_ms(), serde_json::to_string(payload)?],
        )?;
        Ok(())
    }

    pub fn create_pending_action(
        &mut self,
        through_seq: i64,
        description: &str,
        payload: &Value,
        evidence_event_ids: &[String],
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let created_at = now_unix_ms();
        let expires_at = created_at.saturating_add(24 * 60 * 60 * 1000);
        let payload_json = serde_json::to_string(payload)?;
        let evidence_json = serde_json::to_string(evidence_event_ids)?;
        let tx = self.connection.transaction()?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO action_queue
             (id, through_seq, description, payload_json, evidence_event_ids_json, status, created_at_unix_ms, expires_at_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)",
            params![id, through_seq, description, payload_json, evidence_json, created_at, expires_at],
        )?;
        let actual_id: String = tx.query_row(
            "SELECT id FROM action_queue WHERE through_seq = ?1",
            [through_seq],
            |row| row.get(0),
        )?;
        if inserted == 1 {
            Self::audit_action(
                &tx,
                &actual_id,
                "queued",
                &serde_json::json!({
                    "description": description,
                    "expires_at_unix_ms": expires_at,
                    "owner_approval_required": true
                }),
            )?;
        }
        tx.commit()?;
        Ok(actual_id)
    }

    pub fn pending_actions(&mut self, limit: usize) -> Result<Vec<PendingActionRecord>> {
        let now = now_unix_ms();
        let tx = self.connection.transaction()?;
        let expired: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT id FROM action_queue WHERE status = 'pending' AND expires_at_unix_ms <= ?1"
            )?;
            let rows = statement.query_map([now], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in expired {
            tx.execute(
                "UPDATE action_queue SET status = 'expired', completed_at_unix_ms = ?2
                 WHERE id = ?1 AND status = 'pending'",
                params![id, now],
            )?;
            Self::audit_action(&tx, &id, "expired", &serde_json::json!({"reason":"approval_window_elapsed"}))?;
        }
        let rows = {
            let mut statement = tx.prepare(
                "SELECT id, through_seq, description, payload_json, evidence_event_ids_json,
                        status, created_at_unix_ms, expires_at_unix_ms, result_json
                 FROM action_queue WHERE status = 'pending'
                 ORDER BY created_at_unix_ms ASC LIMIT ?1"
            )?;
            let mapped = statement.query_map([limit.min(100) as i64], |row| {
                Ok(PendingActionRecord {
                    id: row.get(0)?,
                    through_seq: row.get(1)?,
                    description: row.get(2)?,
                    payload_json: row.get(3)?,
                    evidence_event_ids_json: row.get(4)?,
                    status: row.get(5)?,
                    created_at_unix_ms: row.get(6)?,
                    expires_at_unix_ms: row.get(7)?,
                    result_json: row.get(8)?,
                })
            })?;
            mapped.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok(rows)
    }

    pub fn automatic_actions_since(&self, since_unix_ms: i64) -> Result<i64> {
        self.connection.query_row(
            "SELECT COUNT(DISTINCT action_id)
             FROM action_audit
             WHERE event_type = 'automatic_policy_approved'
               AND occurred_at_unix_ms >= ?1",
            [since_unix_ms],
            |row| row.get(0),
        ).context("Cannot count completed automatic actions")
    }

    pub fn claim_pending_action(&mut self, id: &str) -> Result<PendingActionRecord> {
        self.claim_pending_action_inner(id)
    }

    /// Atomically checks the automatic-action quota and claims the pending
    /// action in one IMMEDIATE SQLite transaction. Quota exhaustion leaves
    /// the proposal pending for manual review.
    pub fn claim_automatic_pending_action(
        &mut self,
        id: &str,
        day_start_unix_ms: i64,
        daily_limit: u8,
    ) -> Result<Option<PendingActionRecord>> {
        if !(1..=3).contains(&daily_limit) {
            anyhow::bail!("Automatic note quota is outside the hard-coded limit.");
        }
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let completed: i64 = tx.query_row(
            "SELECT COUNT(DISTINCT action_id)
             FROM action_audit
             WHERE event_type = 'automatic_policy_approved'
               AND occurred_at_unix_ms >= ?1",
            [day_start_unix_ms],
            |row| row.get(0),
        )?;
        if completed >= i64::from(daily_limit) {
            tx.rollback()?;
            return Ok(None);
        }

        let now = now_unix_ms();
        let record = tx.query_row(
            "SELECT id, through_seq, description, payload_json, evidence_event_ids_json,
                    status, created_at_unix_ms, expires_at_unix_ms, result_json
             FROM action_queue WHERE id = ?1 AND status = 'pending' AND expires_at_unix_ms > ?2",
            params![id, now],
            |row| {
                Ok(PendingActionRecord {
                    id: row.get(0)?,
                    through_seq: row.get(1)?,
                    description: row.get(2)?,
                    payload_json: row.get(3)?,
                    evidence_event_ids_json: row.get(4)?,
                    status: row.get(5)?,
                    created_at_unix_ms: row.get(6)?,
                    expires_at_unix_ms: row.get(7)?,
                    result_json: row.get(8)?,
                })
            },
        ).optional()?.context("Automatic action is missing, expired, already handled, or currently executing")?;
        let changed = tx.execute(
            "UPDATE action_queue SET status = 'executing', approved_at_unix_ms = ?2
             WHERE id = ?1 AND status = 'pending' AND expires_at_unix_ms > ?2",
            params![id, now],
        )?;
        if changed != 1 {
            anyhow::bail!("Automatic action claim lost a concurrent state transition.");
        }
        Self::audit_action(&tx, id, "automatic_policy_approved", &serde_json::json!({
            "approved_at_unix_ms": now,
            "approval_source": "automatic_policy",
            "daily_limit": daily_limit,
            "through_seq": record.through_seq
        }))?;
        tx.commit()?;
        Ok(Some(record))
    }

    fn claim_pending_action_inner(&mut self, id: &str) -> Result<PendingActionRecord> {
        let now = now_unix_ms();
        let tx = self.connection.transaction()?;
        let record = tx.query_row(
            "SELECT id, through_seq, description, payload_json, evidence_event_ids_json,
                    status, created_at_unix_ms, expires_at_unix_ms, result_json
             FROM action_queue WHERE id = ?1 AND status = 'pending' AND expires_at_unix_ms > ?2",
            params![id, now],
            |row| {
                Ok(PendingActionRecord {
                    id: row.get(0)?,
                    through_seq: row.get(1)?,
                    description: row.get(2)?,
                    payload_json: row.get(3)?,
                    evidence_event_ids_json: row.get(4)?,
                    status: row.get(5)?,
                    created_at_unix_ms: row.get(6)?,
                    expires_at_unix_ms: row.get(7)?,
                    result_json: row.get(8)?,
                })
            },
        ).optional()?.context("Action is missing, expired, already handled, or currently executing")?;
        let changed = tx.execute(
            "UPDATE action_queue SET status = 'executing', approved_at_unix_ms = ?2
             WHERE id = ?1 AND status = 'pending' AND expires_at_unix_ms > ?2",
            params![id, now],
        )?;
        if changed != 1 {
            anyhow::bail!("Action approval lost a concurrent state transition.");
        }
        Self::audit_action(&tx, id, "owner_approved", &serde_json::json!({
            "approved_at_unix_ms": now,
            "approval_source": "owner",
            "through_seq": record.through_seq
        }))?;
        tx.commit()?;
        Ok(record)
    }

    pub fn complete_action(
        &mut self,
        id: &str,
        succeeded: bool,
        result: &Value,
    ) -> Result<()> {
        let now = now_unix_ms();
        let status = if succeeded { "succeeded" } else { "failed" };
        let tx = self.connection.transaction()?;
        let changed = tx.execute(
            "UPDATE action_queue SET status = ?2, completed_at_unix_ms = ?3, result_json = ?4
             WHERE id = ?1 AND status = 'executing'",
            params![id, status, now, serde_json::to_string(result)?],
        )?;
        if changed != 1 {
            anyhow::bail!("Action is not in the executing state; refusing to change its result.");
        }
        Self::audit_action(&tx, id, status, result)?;
        tx.commit()?;
        Ok(())
    }

    pub fn reject_pending_action(&mut self, id: &str) -> Result<()> {
        let now = now_unix_ms();
        let tx = self.connection.transaction()?;
        let changed = tx.execute(
            "UPDATE action_queue SET status = 'rejected', completed_at_unix_ms = ?2
             WHERE id = ?1 AND status = 'pending' AND expires_at_unix_ms > ?2",
            params![id, now],
        )?;
        if changed != 1 {
            anyhow::bail!("Action is missing, expired, already handled, or currently executing.");
        }
        Self::audit_action(&tx, id, "owner_rejected", &serde_json::json!({"rejected_at_unix_ms":now}))?;
        tx.commit()?;
        Ok(())
    }

    pub fn pending_action_count(&self) -> Result<i64> {
        self.connection.query_row(
            "SELECT COUNT(*) FROM action_queue WHERE status = 'pending' AND expires_at_unix_ms > ?1",
            [now_unix_ms()],
            |row| row.get(0),
        ).context("Cannot count pending actions")
    }

    pub fn recover_interrupted_actions(&mut self) -> Result<usize> {
        let now = now_unix_ms();
        let tx = self.connection.transaction()?;
        let ids: Vec<String> = {
            let mut statement = tx.prepare("SELECT id FROM action_queue WHERE status = 'executing'")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in &ids {
            let result = serde_json::json!({
                "error": "The process stopped while this action was executing. Its target must be inspected manually before any retry.",
                "outcome": "uncertain"
            });
            tx.execute(
                "UPDATE action_queue SET status = 'failed', completed_at_unix_ms = ?2, result_json = ?3
                 WHERE id = ?1 AND status = 'executing'",
                params![id, now, serde_json::to_string(&result)?],
            )?;
            Self::audit_action(&tx, id, "recovered_interrupted", &result)?;
        }
        tx.commit()?;
        Ok(ids.len())
    }

    pub fn expire_pending_actions(&mut self, reason: &str) -> Result<usize> {
        let now = now_unix_ms();
        let tx = self.connection.transaction()?;
        let ids: Vec<String> = {
            let mut statement = tx.prepare("SELECT id FROM action_queue WHERE status = 'pending'")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in &ids {
            tx.execute(
                "UPDATE action_queue SET status = 'expired', completed_at_unix_ms = ?2
                 WHERE id = ?1 AND status = 'pending'",
                params![id, now],
            )?;
            Self::audit_action(&tx, id, "expired", &serde_json::json!({"reason":reason}))?;
        }
        tx.commit()?;
        Ok(ids.len())
    }

    pub fn recent_decisions(&self, limit: usize) -> Result<Vec<DecisionRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT id, through_seq, created_at_unix_ms, decision_json
             FROM decisions ORDER BY created_at_unix_ms DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.min(100) as i64], |row| {
            Ok(DecisionRecord {
                id: row.get(0)?,
                through_seq: row.get(1)?,
                created_at_unix_ms: row.get(2)?,
                decision_json: row.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().context("Cannot read reasoning decisions")
    }

    pub fn prune_expired(&mut self, retention_days: u32) -> Result<usize> {
        let cutoff = now_unix_ms() - i64::from(retention_days) * 24 * 60 * 60 * 1000;
        let deleted = self.connection.execute(
            "DELETE FROM events WHERE observed_at_unix_ms < ?1",
            [cutoff],
        )?;
        self.connection.execute(
            "DELETE FROM decisions WHERE created_at_unix_ms < ?1",
            [cutoff],
        )?;
        self.connection.execute(
            "DELETE FROM resources WHERE last_observed_at_unix_ms < ?1",
            [cutoff],
        )?;
        Ok(deleted)
    }

    pub fn forget_history(&mut self) -> Result<()> {
        self.connection.execute_batch(
            "DELETE FROM action_audit;
             DELETE FROM action_queue;
             DELETE FROM events;
             DELETE FROM decisions;
             DELETE FROM resources;
             DELETE FROM sqlite_sequence WHERE name IN ('events', 'action_audit');",
        )?;
        Ok(())
    }

    pub fn counts(&self) -> Result<(i64, i64, i64)> {
        let events = self.connection.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?;
        let resources = self.connection.query_row("SELECT COUNT(*) FROM resources WHERE active = 1", [], |row| row.get(0))?;
        let decisions = self.connection.query_row("SELECT COUNT(*) FROM decisions", [], |row| row.get(0))?;
        Ok((events, resources, decisions))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_insert_and_cursor_are_deterministic() {
        let mut store = Store::open_memory().expect("in-memory database");
        let payload = serde_json::json!({"content_read": false});
        let first = store.append_event("test", "test.observed", None, "agent_observed_at", None, &payload).unwrap();
        let second = store.append_event("test", "test.observed", None, "agent_observed_at", None, &payload).unwrap();
        assert!(second > first);
        let events = store.events_after(first, 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].seq, second);
    }

    #[test]
    fn unchanged_metadata_does_not_duplicate_snapshot_events() {
        let mut store = Store::open_memory().unwrap();
        assert_eq!(store.observe_file("/allowed", "/allowed/a.txt", 7, Some(100), "snapshot").unwrap(), 1);
        assert_eq!(store.observe_file("/allowed", "/allowed/a.txt", 7, Some(100), "snapshot").unwrap(), 0);
        assert_eq!(store.observe_file("/allowed", "/allowed/a.txt", 8, Some(101), "snapshot").unwrap(), 2);
        assert_eq!(store.counts().unwrap().0, 2);
    }

    #[test]
    fn action_creation_is_idempotent_for_a_decision_cursor() {
        let mut store = Store::open_memory().unwrap();
        let payload = serde_json::json!({
            "kind": "create_note",
            "root_index": 0,
            "filename": "daily.md",
            "content": "Metadata-only note."
        });
        let evidence = vec!["event-a".to_owned()];
        let first = store.create_pending_action(42, "Create note", &payload, &evidence).unwrap();
        let second = store.create_pending_action(42, "Create note", &payload, &evidence).unwrap();
        assert_eq!(first, second);
        assert_eq!(store.pending_action_count().unwrap(), 1);
    }

    #[test]
    fn action_claim_and_completion_are_one_shot() {
        let mut store = Store::open_memory().unwrap();
        let payload = serde_json::json!({
            "kind": "create_note",
            "root_index": 0,
            "filename": "daily.md",
            "content": "Metadata-only note."
        });
        let id = store.create_pending_action(7, "Create note", &payload, &["event-a".to_owned()]).unwrap();
        let claimed = store.claim_pending_action(&id).unwrap();
        assert_eq!(claimed.status, "pending");
        assert!(store.claim_pending_action(&id).is_err());
        store.complete_action(&id, true, &serde_json::json!({"created": true})).unwrap();
        assert!(store.claim_pending_action(&id).is_err());
        assert_eq!(store.pending_action_count().unwrap(), 0);
    }

    #[test]
    fn interrupted_action_is_not_retried_automatically() {
        let mut store = Store::open_memory().unwrap();
        let payload = serde_json::json!({
            "kind": "create_note",
            "root_index": 0,
            "filename": "daily.md",
            "content": "Metadata-only note."
        });
        let id = store.create_pending_action(9, "Create note", &payload, &["event-b".to_owned()]).unwrap();
        store.claim_pending_action(&id).unwrap();
        assert_eq!(store.recover_interrupted_actions().unwrap(), 1);
        assert!(store.claim_pending_action(&id).is_err());
        assert_eq!(store.pending_action_count().unwrap(), 0);
    }

    #[test]
    fn automatic_quota_counts_claims_including_failed_attempts() {
        let mut store = Store::open_memory().unwrap();
        let payload = serde_json::json!({"kind":"create_note","root_index":0,"filename":"daily.md","content":"Body"});
        let first = store.create_pending_action(20, "automatic one", &payload, &["event-a".to_owned()]).unwrap();
        let claimed = store.claim_automatic_pending_action(&first, 0, 3).unwrap().unwrap();
        assert_eq!(claimed.status, "pending");
        assert_eq!(store.automatic_actions_since(0).unwrap(), 1);

        store.complete_action(&first, false, &serde_json::json!({"outcome":"uncertain"})).unwrap();

        let manual = store.create_pending_action(21, "manual", &payload, &["event-b".to_owned()]).unwrap();
        store.claim_pending_action(&manual).unwrap();
        store.complete_action(&manual, true, &serde_json::json!({"ok":true})).unwrap();
        assert_eq!(store.automatic_actions_since(0).unwrap(), 1);

        let second = store.create_pending_action(22, "automatic two", &payload, &["event-c".to_owned()]).unwrap();
        assert!(store.claim_automatic_pending_action(&second, 0, 3).unwrap().is_some());
        assert_eq!(store.automatic_actions_since(0).unwrap(), 2);
    }

    #[test]
    fn rejected_action_cannot_be_claimed() {
        let mut store = Store::open_memory().unwrap();
        let payload = serde_json::json!({
            "kind": "create_note",
            "root_index": 0,
            "filename": "daily.md",
            "content": "Metadata-only note."
        });
        let id = store.create_pending_action(11, "Create note", &payload, &["event-c".to_owned()]).unwrap();
        store.reject_pending_action(&id).unwrap();
        assert!(store.claim_pending_action(&id).is_err());
    }

    #[test]
    fn history_purge_removes_events_decisions_and_resources() {
        let mut store = Store::open_memory().unwrap();
        store.observe_file("/allowed", "/allowed/a.txt", 7, Some(100), "snapshot").unwrap();
        store.forget_history().unwrap();
        assert_eq!(store.counts().unwrap(), (0, 0, 0));
    }
    #[test]
    fn sqlcipher_encrypts_and_rejects_wrong_key() {
        let path = std::env::temp_dir().join(format!("miss-minutes-encrypted-{}.db", Uuid::new_v4()));
        {
            let connection = open_encrypted_connection(&path, &[0x11; 32]).unwrap();
            connection.execute_batch("CREATE TABLE secret(value TEXT); INSERT INTO secret VALUES('private');").unwrap();
        }
        let reopened = open_encrypted_connection(&path, &[0x11; 32]).unwrap();
        let value: String = reopened.query_row("SELECT value FROM secret", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "private");
        drop(reopened);
        assert!(open_encrypted_connection(&path, &[0x22; 32]).is_err());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn plaintext_ledger_migration_preserves_rows_and_removes_plaintext() {
        let path = std::env::temp_dir().join(format!("miss-minutes-legacy-{}.db", Uuid::new_v4()));
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('keep-me');").unwrap();
        }
        let key = [0x33; 32];
        migrate_plaintext_database(&path, &key).unwrap();
        let encrypted = open_encrypted_connection(&path, &key).unwrap();
        let value: String = encrypted.query_row("SELECT value FROM legacy", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "keep-me");
        drop(encrypted);
        assert!(!is_plaintext_database(&path).unwrap());
        let _ = fs::remove_file(&path);
    }

}
