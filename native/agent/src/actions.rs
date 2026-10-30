use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::fs::File;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    config::AgentConfig,
    store::{PendingActionRecord, Store},
};

/// Compare canonical paths without treating Windows' extended-length prefix or
/// case-insensitive path spelling as a different directory.
#[cfg(windows)]
fn same_canonical_path(left: &Path, right: &Path) -> bool {
    fn normalize(path: &Path) -> String {
        let value = path.to_string_lossy().replace('/', "\\");
        let value = value.strip_prefix(r"\\?\").unwrap_or(&value);
        value.to_ascii_lowercase()
    }
    normalize(left) == normalize(right)
}

#[cfg(not(windows))]
fn same_canonical_path(left: &Path, right: &Path) -> bool {
    left == right
}

/// The finite native capability set. The model cannot ask for a shell, script,
/// process launch, network request, overwrite, move, or delete operation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ActionPayload {
    CreateNote {
        root_index: usize,
        filename: String,
        content: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionExecutionResult {
    pub action_id: String,
    pub status: String,
    pub created_path: Option<String>,
    pub bytes_written: usize,
    pub detail: String,
}

pub fn validate_payload(payload: &ActionPayload, approved_root_count: usize) -> Result<()> {
    match payload {
        ActionPayload::CreateNote { root_index, filename, content } => {
            if *root_index >= approved_root_count {
                bail!("The action refers to a note folder that has not been approved.");
            }
            validate_note_filename(filename)?;
            if content.trim().is_empty() || content.len() > 8192 || content.contains('\\0') {
                bail!("Note content must contain 1 to 8192 bytes and cannot contain NUL.");
            }
        }
    }
    Ok(())
}

fn validate_note_filename(filename: &str) -> Result<()> {
    let stem = filename.strip_suffix(".md")
        .context("Only new Markdown files with a .md extension are supported.")?;
    if stem.is_empty()
        || stem.len() > 48
        || !stem.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        bail!("Note filename must be a 1–48 character ASCII slug followed by .md.");
    }
    Ok(())
}

fn create_note(root: &Path, filename: &str, content: &str) -> Result<PathBuf> {
    validate_note_filename(filename)?;
    if content.trim().is_empty() || content.len() > 8192 || content.contains('\\0') {
        bail!("Note content failed size or NUL validation.");
    }

    let canonical_root = fs::canonicalize(root)
        .with_context(|| format!("Cannot resolve approved note folder {}", root.display()))?;
    if !same_canonical_path(&canonical_root, root) || !canonical_root.is_dir() {
        bail!("Approved note folder changed or is not a canonical directory.");
    }

    let destination = canonical_root.join(filename);
    let temporary = canonical_root.join(format!(".miss-minute-{}.tmp", Uuid::new_v4()));

    let write_result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)
            .with_context(|| format!("Cannot create temporary note in {}", canonical_root.display()))?;
        file.write_all(content.as_bytes()).context("Cannot write note body")?;
        file.sync_all().context("Cannot flush note contents to disk")?;
        drop(file);

        // Hard-link creation is atomic and fails when the destination exists.
        fs::hard_link(&temporary, &destination)
            .with_context(|| format!("Cannot create {} without overwriting an existing path", destination.display()))?;
        fs::remove_file(&temporary).context("Note was created, but the temporary hard link could not be removed")?;

        #[cfg(unix)]
        File::open(&canonical_root)
            .and_then(|directory| directory.sync_all())
            .context("Cannot flush note directory metadata")?;

        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result?;
    Ok(destination)
}

fn execute_claimed_action(
    config: &AgentConfig,
    store: &mut Store,
    pending: PendingActionRecord,
) -> Result<ActionExecutionResult> {
    let result = (|| -> Result<(PathBuf, usize)> {
        let payload: ActionPayload = serde_json::from_str(&pending.payload_json)
            .context("Stored action payload is malformed; refusing execution")?;
        validate_payload(&payload, config.approved_note_roots.len())?;

        match payload {
            ActionPayload::CreateNote { root_index, filename, content } => {
                let root = config.approved_note_roots.get(root_index)
                    .context("Approved note folder no longer exists in the permission set")?;
                let path = create_note(root, &filename, &content)?;
                Ok((path, content.len()))
            }
        }
    })();

    match result {
        Ok((path, bytes_written)) => {
            let outcome = ActionExecutionResult {
                action_id: pending.id.clone(),
                status: "succeeded".to_owned(),
                created_path: Some(path.display().to_string()),
                bytes_written,
                detail: "A new Markdown note was created. Existing files were not overwritten.".to_owned(),
            };
            store.complete_action(&pending.id, true, &json!(outcome))?;
            Ok(outcome)
        }
        Err(error) => {
            let outcome = ActionExecutionResult {
                action_id: pending.id.clone(),
                status: "failed".to_owned(),
                created_path: None,
                bytes_written: 0,
                detail: format!("{error:#}"),
            };
            store.complete_action(&pending.id, false, &json!(outcome))?;
            Err(error)
        }
    }
}

pub fn approve_and_execute(
    config: &AgentConfig,
    store: &mut Store,
    action_id: &str,
) -> Result<ActionExecutionResult> {
    let pending = store.claim_pending_action(action_id)?;
    execute_claimed_action(config, store, pending)
}

/// Executes a pending create_note proposal only when the owner has enabled the
/// single-capability automatic policy and the hard UTC daily quota is not spent.
pub fn auto_execute_if_enabled(
    config: &AgentConfig,
    store: &mut Store,
    action_id: &str,
) -> Result<Option<ActionExecutionResult>> {
    if !config.automation.auto_create_notes {
        return Ok(None);
    }
    if config.approved_note_roots.is_empty() {
        bail!("Automatic note creation is enabled without an approved output folder; refusing execution.");
    }

    let now = crate::config::now_unix_ms();
    const DAY_MS: i64 = 86_400_000;
    let utc_day_start = now.div_euclid(DAY_MS) * DAY_MS;
    let Some(pending) = store.claim_automatic_pending_action(
        action_id,
        utc_day_start,
        config.automation.max_notes_per_utc_day,
    )? else {
        return Ok(None);
    };

    execute_claimed_action(config, store, pending).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(enabled: bool, daily_limit: u8) -> (AgentConfig, PathBuf) {
        let base = std::env::temp_dir().join(format!("miss-minute-auto-{}", Uuid::new_v4()));
        let workspace_path = base.join("workspace");
        let notes_path = workspace_path.join("notes");
        fs::create_dir_all(&notes_path).unwrap();
        // Persist canonical paths as enrollment does. Windows may return an
        // extended-length spelling on subsequent canonicalize calls.
        let workspace = fs::canonicalize(&workspace_path).unwrap();
        let notes = fs::canonicalize(&notes_path).unwrap();
        let config = AgentConfig {
            schema_version: crate::config::CONFIG_SCHEMA_VERSION,
            consent: crate::config::OwnerConsent {
                confirmed: true,
                granted_at_unix_ms: crate::config::now_unix_ms(),
                allowed_roots: vec![workspace],
            },
            capture: crate::config::CapturePolicy {
                file_metadata: true,
                file_contents: false,
                follow_symlinks: false,
            },
            database_path: base.join("agent.sqlite3"),
            retention_days: 30,
            approved_note_roots: vec![notes],
            automation: crate::config::AutomationPolicy {
                auto_create_notes: enabled,
                max_notes_per_utc_day: daily_limit,
            },
            reasoner: None,
        };
        (config, base)
    }

    fn queue_note(store: &mut Store, through: i64, filename: &str) -> String {
        let payload = serde_json::json!({
            "kind": "create_note",
            "root_index": 0,
            "filename": filename,
            "content": "# Metadata summary\\n\\nGenerated from owner-authorized file metadata only."
        });
        store.create_pending_action(
            through,
            "Create a metadata summary note",
            &payload,
            &["evidence-event".to_owned()],
        ).unwrap()
    }

    #[test]
    fn automatic_mode_off_never_executes_a_pending_action() {
        let (config, base) = fixture(false, 3);
        let mut store = Store::open(&config.database_path).unwrap();
        let id = queue_note(&mut store, 1, "manual-review.md");

        assert!(auto_execute_if_enabled(&config, &mut store, &id).unwrap().is_none());
        assert!(!config.approved_note_roots[0].join("manual-review.md").exists());
        assert_eq!(store.pending_action_count().unwrap(), 1);

        drop(store);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn explicit_automatic_policy_executes_only_the_typed_note_capability() {
        let (config, base) = fixture(true, 3);
        let mut store = Store::open(&config.database_path).unwrap();
        let id = queue_note(&mut store, 2, "automatic-note.md");

        let outcome = auto_execute_if_enabled(&config, &mut store, &id).unwrap().unwrap();
        assert_eq!(outcome.status, "succeeded");
        assert_eq!(
            fs::read_to_string(config.approved_note_roots[0].join("automatic-note.md")).unwrap(),
            "# Metadata summary\\n\\nGenerated from owner-authorized file metadata only."
        );
        assert_eq!(store.pending_action_count().unwrap(), 0);

        drop(store);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn automatic_policy_stops_after_its_utc_daily_quota() {
        let (config, base) = fixture(true, 1);
        let mut store = Store::open(&config.database_path).unwrap();
        let first = queue_note(&mut store, 3, "first.md");
        assert!(auto_execute_if_enabled(&config, &mut store, &first).unwrap().is_some());

        let second = queue_note(&mut store, 4, "second.md");
        assert!(auto_execute_if_enabled(&config, &mut store, &second).unwrap().is_none());
        assert!(!config.approved_note_roots[0].join("second.md").exists());
        assert_eq!(store.pending_action_count().unwrap(), 1);

        drop(store);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn payload_rejects_unapproved_root() {
        let payload = ActionPayload::CreateNote {
            root_index: 1,
            filename: "plan.md".to_owned(),
            content: "A small plan.".to_owned(),
        };
        assert!(validate_payload(&payload, 1).is_err());
    }

    #[test]
    fn payload_rejects_traversal_and_non_markdown_targets() {
        for filename in ["../escape.md", "subdir/note.md", "note.txt", ".hidden.md", "bad name.md"] {
            assert!(validate_note_filename(filename).is_err(), "{filename} should be rejected");
        }
    }

    #[test]
    fn create_note_never_overwrites_an_existing_file() {
        let root = std::env::temp_dir().join(format!("miss-minute-actions-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let target = root.join("daily.md");
        fs::write(&target, "original").unwrap();

        let result = create_note(&root, "daily.md", "replacement");
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_note_uses_exclusive_atomic_target_creation() {
        let root = std::env::temp_dir().join(format!("miss-minute-actions-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();

        let result = create_note(&root, "daily-note.md", "A generated note.").unwrap();
        assert_eq!(fs::read_to_string(&result).unwrap(), "A generated note.");
        assert!(!root.join(".miss-minute-placeholder.tmp").exists());

        fs::remove_dir_all(root).unwrap();
    }
}
