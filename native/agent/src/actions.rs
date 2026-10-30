use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    config::AgentConfig,
    store::{PendingActionRecord, Store},
};

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
            if content.trim().is_empty() || content.len() > 8192 || content.contains('\0') {
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
    if content.trim().is_empty() || content.len() > 8192 || content.contains('\0') {
        bail!("Note content failed size or NUL validation.");
    }

    let canonical_root = fs::canonicalize(root)
        .with_context(|| format!("Cannot resolve approved note folder {}", root.display()))?;
    if canonical_root != root || !canonical_root.is_dir() {
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
        // Unlike rename-on-some-platforms, it cannot silently replace a file.
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

pub fn approve_and_execute(
    config: &AgentConfig,
    store: &mut Store,
    action_id: &str,
) -> Result<ActionExecutionResult> {
    let pending: PendingActionRecord = store.claim_pending_action(action_id)?;
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

#[cfg(test)]
mod tests {
    use super::*;

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

        let result = create_note(&root, "daily-note.md", "A generated note.").unwrap();
        assert_eq!(fs::read_to_string(&result).unwrap(), "A generated note.");
        assert!(!root.join(".miss-minute-placeholder.tmp").exists());

        fs::remove_dir_all(root).unwrap();
    }
}
