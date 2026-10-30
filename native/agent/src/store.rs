use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
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

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Cannot create database directory {}", parent.display()))?;
        }

        let connection = Connection::open(path)
            .with_context(|| format!("Cannot open local event database {}", path.display()))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if path.exists() {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                    .with_context(|| format!("Cannot restrict database permissions: {}", path.display()))?;
            }
        }

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
             PRAGMA synchronous=NORMAL;
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
             CREATE INDEX IF NOT EXISTS decisions_created_idx ON decisions(created_at_unix_ms DESC);",
        )?;
        Ok(Self { connection })
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
            "DELETE FROM events;
             DELETE FROM decisions;
             DELETE FROM resources;
             DELETE FROM sqlite_sequence WHERE name = 'events';",
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
    fn history_purge_removes_events_decisions_and_resources() {
        let mut store = Store::open_memory().unwrap();
        store.observe_file("/allowed", "/allowed/a.txt", 7, Some(100), "snapshot").unwrap();
        store.forget_history().unwrap();
        assert_eq!(store.counts().unwrap(), (0, 0, 0));
    }
}
