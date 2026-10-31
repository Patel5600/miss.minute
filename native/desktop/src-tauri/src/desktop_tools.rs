//! PC control behind explicit approval.
//!
//! The model can only *propose*. `desktop_propose` validates the arguments, resolves every
//! path, stores the exact action and returns a plain-language preview. Nothing runs until the
//! owner approves that preview: `desktop_approve(id)` executes the *stored* action (never
//! arguments re-sent by the renderer), once, within ten minutes. Read-only, harmless queries
//! (`list_apps`, `system_info`) run directly through `desktop_run`.
//!
//! Every proposal, decision and result is appended to `desktop-audit.jsonl` in the app data
//! directory. File contents, command output and secrets are never written to the audit log.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Manager;

use crate::util::{app_data_dir, now_ms, open_in_browser};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProposal {
    pub id: String,
    pub tool: String,
    pub args: serde_json::Value,
    pub preview: String,
    pub content_preview: Option<String>,
    /// low | medium | high
    pub risk: String,
    pub expires_at_unix_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActionResult {
    pub ok: bool,
    pub summary: String,
    pub output: Option<String>,
}

const PROPOSAL_TTL_MS: i64 = 10 * 60 * 1000;
const MAX_PROPOSALS: usize = 32;
const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_LIST_ENTRIES: usize = 200;
const MAX_COPY_ENTRIES: usize = 5_000;
const DEFAULT_COMMAND_SECS: u64 = 60;
const MAX_COMMAND_SECS: u64 = 300;
const MAX_ARG_CHARS: usize = 1024;
const MAX_COMMAND_CHARS: usize = 8 * 1024;

#[derive(Clone, Debug)]
enum WriteMode {
    Create,
    Overwrite,
    Append,
}

#[derive(Clone, Debug)]
enum Action {
    OpenTarget { target: String, what: String },
    ListDirectory { path: PathBuf },
    ReadTextFile { path: PathBuf, max_bytes: u64 },
    WriteTextFile { path: PathBuf, content: String, mode: WriteMode },
    MakeDirectory { path: PathBuf },
    MovePath { from: PathBuf, to: PathBuf },
    CopyPath { from: PathBuf, to: PathBuf },
    DeletePath { path: PathBuf },
    RunCommand { command: String, cwd: PathBuf, timeout_secs: u64 },
}

struct Stored {
    proposal: DesktopProposal,
    action: Action,
}

fn store() -> &'static Mutex<HashMap<String, Stored>> {
    static STORE: OnceLock<Mutex<HashMap<String, Stored>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn desktop_propose(
    tool: String,
    args: serde_json::Value,
    window: tauri::WebviewWindow,
) -> Result<DesktopProposal, String> {
    crate::require_dashboard(&window)?;
    let app = window.app_handle().clone();
    let tool_name = tool.clone();
    let args_copy = args.clone();
    let (action, preview, content_preview, risk) =
        tauri::async_runtime::spawn_blocking(move || plan(&app, &tool_name, &args_copy))
            .await
            .map_err(|error| format!("Could not prepare the action: {error}"))??;

    let proposal = DesktopProposal {
        id: uuid::Uuid::new_v4().to_string(),
        tool: tool.clone(),
        args,
        preview,
        content_preview,
        risk: risk.to_owned(),
        expires_at_unix_ms: now_ms() + PROPOSAL_TTL_MS,
    };

    {
        let mut proposals = store().lock().map_err(|_| "Desktop action state is unavailable.".to_owned())?;
        let now = now_ms();
        proposals.retain(|_, stored| stored.proposal.expires_at_unix_ms > now);
        if proposals.len() >= MAX_PROPOSALS {
            return Err("Too many actions are waiting for approval. Approve or decline some first.".to_owned());
        }
        proposals.insert(proposal.id.clone(), Stored { proposal: proposal.clone(), action });
    }
    audit(window.app_handle(), json!({
        "event": "proposed", "id": proposal.id, "tool": proposal.tool, "risk": proposal.risk, "preview": proposal.preview,
    }));
    Ok(proposal)
}

#[tauri::command]
pub async fn desktop_run(
    tool: String,
    args: serde_json::Value,
    window: tauri::WebviewWindow,
) -> Result<DesktopActionResult, String> {
    crate::require_dashboard(&window)?;
    let result = tauri::async_runtime::spawn_blocking(move || match tool.as_str() {
        "list_apps" => list_apps(args.get("query").and_then(Value::as_str)),
        "system_info" => system_info(),
        other => Err(format!("\"{other}\" needs your approval first; it cannot run directly.")),
    })
    .await
    .map_err(|error| format!("The query failed: {error}"))??;
    Ok(result)
}

#[tauri::command]
pub async fn desktop_approve(id: String, window: tauri::WebviewWindow) -> Result<DesktopActionResult, String> {
    crate::require_dashboard(&window)?;
    let stored = {
        let mut proposals = store().lock().map_err(|_| "Desktop action state is unavailable.".to_owned())?;
        proposals.remove(&id)
    }
    .ok_or_else(|| "That action is no longer waiting for approval.".to_owned())?;

    let app = window.app_handle().clone();
    if stored.proposal.expires_at_unix_ms <= now_ms() {
        audit(&app, json!({ "event": "expired", "id": id, "tool": stored.proposal.tool }));
        return Err("That approval expired. Ask her again.".to_owned());
    }
    audit(&app, json!({ "event": "approved", "id": id, "tool": stored.proposal.tool }));

    let action = stored.action;
    let outcome = tauri::async_runtime::spawn_blocking(move || execute(action))
        .await
        .map_err(|error| format!("The action failed: {error}"))?;
    let result = match outcome {
        Ok(result) => result,
        Err(message) => DesktopActionResult { ok: false, summary: message, output: None },
    };
    audit(&app, json!({ "event": "result", "id": id, "tool": stored.proposal.tool, "ok": result.ok, "summary": result.summary }));
    Ok(result)
}

#[tauri::command]
pub fn desktop_reject(id: String, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::require_dashboard(&window)?;
    let removed = store().lock().map_err(|_| "Desktop action state is unavailable.".to_owned())?.remove(&id);
    if let Some(stored) = removed {
        audit(window.app_handle(), json!({ "event": "rejected", "id": id, "tool": stored.proposal.tool }));
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_audit(limit: Option<u32>, window: tauri::WebviewWindow) -> Result<Vec<serde_json::Value>, String> {
    crate::require_dashboard(&window)?;
    let path = app_data_dir(window.app_handle())?.join("desktop-audit.jsonl");
    let Ok(file) = std::fs::File::open(&path) else { return Ok(Vec::new()) };
    let lines: Vec<String> = BufReader::new(file).lines().map_while(Result::ok).collect();
    let limit = limit.unwrap_or(100).clamp(1, 1000) as usize;
    Ok(lines
        .iter()
        .rev()
        .take(limit)
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect())
}

/// Captures the primary screen as a PNG data URL (at most 1600 px wide). Only ever called
/// after the owner approves a look_at_screen request in the dashboard.
#[tauri::command]
pub async fn capture_screen(window: tauri::WebviewWindow) -> Result<String, String> {
    crate::require_dashboard(&window)?;
    let app = window.app_handle().clone();
    let data = tauri::async_runtime::spawn_blocking(screenshot)
        .await
        .map_err(|error| format!("Screen capture failed: {error}"))??;
    audit(&app, json!({ "event": "screen-captured" }));
    Ok(data)
}

// ── Planning: validation, path resolution and previews ───────────────────────────────────

type Plan = (Action, String, Option<String>, &'static str);

fn plan(app: &tauri::AppHandle, tool: &str, args: &Value) -> Result<Plan, String> {
    let guard = Guard::new(app);
    match tool {
        "open_app" => {
            let name = text_arg(args, "name")?;
            let apps = start_menu_entries();
            let app_entry = best_app_match(&apps, &name)
                .ok_or_else(|| format!("I couldn't find an app called \"{name}\" in your Start menu."))?;
            let target = app_entry.1.to_string_lossy().into_owned();
            Ok((
                Action::OpenTarget { target: target.clone(), what: app_entry.0.clone() },
                format!("Open {} ({target}).", app_entry.0),
                None,
                "low",
            ))
        }
        "open_url" => {
            let raw = text_arg(args, "url")?;
            let parsed = url::Url::parse(&raw).map_err(|_| format!("\"{raw}\" is not a valid web address."))?;
            if parsed.scheme() != "https" && parsed.scheme() != "http" {
                return Err("Only http and https links can be opened.".to_owned());
            }
            let url = parsed.to_string();
            Ok((
                Action::OpenTarget { target: url.clone(), what: url.clone() },
                format!("Open {url} in your default browser."),
                None,
                "low",
            ))
        }
        "open_path" => {
            let path = resolve_existing(&text_arg(args, "path")?)?;
            let shown = display(&path);
            let kind = if path.is_dir() { "folder" } else { "file" };
            Ok((
                Action::OpenTarget { target: shown.clone(), what: shown.clone() },
                format!("Open the {kind} {shown} with its default program."),
                None,
                "low",
            ))
        }
        "list_directory" => {
            let path = resolve_existing(&text_arg(args, "path")?)?;
            if !path.is_dir() {
                return Err(format!("{} is not a folder.", display(&path)));
            }
            Ok((
                Action::ListDirectory { path: path.clone() },
                format!("List what is inside {} (names, sizes and dates; nothing is changed). Up to {MAX_LIST_ENTRIES} items are sent to your AI provider.", display(&path)),
                None,
                "medium",
            ))
        }
        "read_text_file" => {
            let path = resolve_existing(&text_arg(args, "path")?)?;
            if !path.is_file() {
                return Err(format!("{} is not a file.", display(&path)));
            }
            let max_bytes = args
                .get("max_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(MAX_READ_BYTES)
                .clamp(1, MAX_READ_BYTES);
            Ok((
                Action::ReadTextFile { path: path.clone(), max_bytes },
                format!("Read the text of {} (up to {} KB) and share it with Miss Minutes and your AI provider. Nothing is changed.", display(&path), max_bytes / 1024),
                None,
                "medium",
            ))
        }
        "write_text_file" => {
            let path = resolve_target(&text_arg(args, "path")?)?;
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .ok_or("write_text_file needs \"content\".")?
                .to_owned();
            if content.len() > MAX_WRITE_BYTES {
                return Err("That text is too large to write (2 MB limit).".to_owned());
            }
            if content.contains('\0') {
                return Err("The text contains a NUL character.".to_owned());
            }
            guard.check_write(&path)?;
            let mode = match args.get("mode").and_then(Value::as_str).unwrap_or("create") {
                "create" => WriteMode::Create,
                "overwrite" => WriteMode::Overwrite,
                "append" => WriteMode::Append,
                other => return Err(format!("Unknown write mode \"{other}\" (use create, overwrite or append).")),
            };
            let shown = display(&path);
            let preview = match mode {
                WriteMode::Create => {
                    if path.exists() {
                        return Err(format!("{shown} already exists. Ask her to overwrite or append instead."));
                    }
                    format!("Create the new file {shown} with the text below.")
                }
                WriteMode::Overwrite if path.exists() => format!(
                    "Replace everything in {shown} with the text below. The current version is kept as {}.",
                    display(&backup_path(&path))
                ),
                WriteMode::Overwrite => format!("Create the new file {shown} with the text below."),
                WriteMode::Append => format!("Add the text below to the end of {shown}."),
            };
            if path.is_dir() {
                return Err(format!("{shown} is a folder."));
            }
            Ok((Action::WriteTextFile { path, content: content.clone(), mode }, preview, Some(content), "medium"))
        }
        "make_directory" => {
            let path = resolve_target(&text_arg(args, "path")?)?;
            guard.check_write(&path)?;
            if path.exists() {
                return Err(format!("{} already exists.", display(&path)));
            }
            Ok((Action::MakeDirectory { path: path.clone() }, format!("Create the folder {}.", display(&path)), None, "medium"))
        }
        "move_path" | "copy_path" => {
            let from = resolve_existing(&text_arg(args, "from")?)?;
            let mut to = resolve_target(&text_arg(args, "to")?)?;
            if to.is_dir() {
                to = to.join(from.file_name().ok_or("That path has no name.")?);
            }
            if to.exists() {
                return Err(format!("{} already exists; I never overwrite.", display(&to)));
            }
            if to.starts_with(&from) {
                return Err("A folder cannot be put inside itself.".to_owned());
            }
            guard.check_write(&to)?;
            if tool == "move_path" {
                guard.check_remove(&from)?;
                Ok((Action::MovePath { from: from.clone(), to: to.clone() }, format!("Move {} to {}.", display(&from), display(&to)), None, "medium"))
            } else {
                Ok((Action::CopyPath { from: from.clone(), to: to.clone() }, format!("Copy {} to {}.", display(&from), display(&to)), None, "medium"))
            }
        }
        "delete_path" => {
            let path = resolve_existing(&text_arg(args, "path")?)?;
            guard.check_remove(&path)?;
            let kind = if path.is_dir() { "folder and everything in it" } else { "file" };
            Ok((
                Action::DeletePath { path: path.clone() },
                format!("Move the {kind} {} to the Recycle Bin. You can restore it from there.", display(&path)),
                None,
                "high",
            ))
        }
        "run_command" => {
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("run_command needs a \"command\".")?
                .to_owned();
            if command.len() > MAX_COMMAND_CHARS || command.contains('\0') {
                return Err("That command is too long or contains invalid characters.".to_owned());
            }
            let cwd = match args.get("cwd").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
                Some(raw) => resolve_existing(raw)?,
                None => home_dir()?,
            };
            if !cwd.is_dir() {
                return Err(format!("{} is not a folder.", display(&cwd)));
            }
            let timeout_secs = args
                .get("timeout_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_COMMAND_SECS)
                .clamp(1, MAX_COMMAND_SECS);
            Ok((
                Action::RunCommand { command: command.clone(), cwd: cwd.clone(), timeout_secs },
                format!("Run this PowerShell command in {} (it is stopped after {timeout_secs} seconds, and anything it starts closes when Miss Minutes closes):", display(&cwd)),
                Some(command),
                "high",
            ))
        }
        "list_apps" | "system_info" => Err(format!("\"{tool}\" is read-only and runs without approval.")),
        other => Err(format!("Unknown desktop tool \"{other}\".")),
    }
}

fn text_arg(args: &Value, key: &str) -> Result<String, String> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing \"{key}\"."))?;
    if value.chars().count() > MAX_ARG_CHARS || value.contains('\0') {
        return Err(format!("\"{key}\" is too long or contains invalid characters."));
    }
    Ok(value.to_owned())
}

/// Where writes, moves and deletes may never go.
struct Guard {
    forbidden: Vec<PathBuf>,
    /// Folders that may be written into but never removed or moved themselves.
    keep: Vec<PathBuf>,
}

impl Guard {
    fn new(app: &tauri::AppHandle) -> Self {
        let mut forbidden = Vec::new();
        for var in ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Ok(value) = std::env::var(var) {
                forbidden.push(lower(&PathBuf::from(value)));
            }
        }
        if let Ok(dir) = app_data_dir(app) {
            forbidden.push(lower(&strip_verbatim(dir.canonicalize().unwrap_or(dir))));
        }
        let mut keep = Vec::new();
        if let Ok(home) = home_dir() {
            keep.push(lower(&home));
            for name in KNOWN_FOLDERS {
                if let Some(path) = known_folder(name) {
                    keep.push(lower(&path));
                }
            }
        }
        Self { forbidden, keep }
    }

    fn check_write(&self, path: &Path) -> Result<(), String> {
        let low = lower(path);
        if self.forbidden.iter().any(|root| low.starts_with(root)) {
            return Err(format!("{} is inside a protected system or app folder. I won't change it.", display(path)));
        }
        Ok(())
    }

    fn check_remove(&self, path: &Path) -> Result<(), String> {
        self.check_write(path)?;
        let low = lower(path);
        if path.parent().is_none() || low.components().count() <= 1 {
            return Err("I won't remove a whole drive.".to_owned());
        }
        if self.keep.iter().any(|kept| *kept == low) {
            return Err(format!("{} is one of your main folders. I won't move or delete it.", display(path)));
        }
        Ok(())
    }
}

fn lower(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().to_lowercase())
}

const KNOWN_FOLDERS: [&str; 6] = ["desktop", "documents", "downloads", "pictures", "music", "videos"];

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .ok_or_else(|| "Your user folder could not be found.".to_owned())
}

#[cfg(windows)]
fn known_folder(name: &str) -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures, FOLDERID_Videos,
        KNOWN_FOLDER_FLAG, SHGetKnownFolderPath,
    };
    let id = match name {
        "desktop" => FOLDERID_Desktop,
        "documents" => FOLDERID_Documents,
        "downloads" => FOLDERID_Downloads,
        "pictures" => FOLDERID_Pictures,
        "music" => FOLDERID_Music,
        "videos" => FOLDERID_Videos,
        _ => return None,
    };
    // SAFETY: the returned buffer is freed with CoTaskMemFree exactly once.
    unsafe {
        let raw = SHGetKnownFolderPath(&id, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let path = raw.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(raw.0 as *const _));
        path
    }
}

#[cfg(not(windows))]
fn known_folder(name: &str) -> Option<PathBuf> {
    let mut title = name.to_owned();
    if let Some(first) = title.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    home_dir().ok().map(|home| home.join(title))
}

/// Expands ~, %VARS% and a leading Desktop/Documents/Downloads/Pictures/Music/Videos, then
/// makes the path absolute (relative paths are relative to the user folder).
fn expand(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim().trim_matches('"');
    if raw.starts_with(r"\\") || raw.starts_with("//") {
        return Err("Network and device paths are not allowed.".to_owned());
    }
    let mut text = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else { break };
        let name = &after[..end];
        text.push_str(&rest[..start]);
        match std::env::var(name) {
            Ok(value) if !name.is_empty() => text.push_str(&value),
            _ => return Err(format!("%{name}% is not a known folder variable.")),
        }
        rest = &after[end + 1..];
    }
    text.push_str(rest);

    let home = home_dir()?;
    let path = if text == "~" {
        home
    } else if let Some(stripped) = text.strip_prefix("~\\").or_else(|| text.strip_prefix("~/")) {
        home.join(stripped)
    } else {
        let candidate = PathBuf::from(&text);
        if candidate.is_absolute() {
            candidate
        } else {
            let mut parts = text.splitn(2, ['\\', '/']);
            let first = parts.next().unwrap_or("").to_lowercase();
            match KNOWN_FOLDERS.iter().find(|name| **name == first).and_then(|name| known_folder(name)) {
                Some(folder) => match parts.next() {
                    Some(tail) if !tail.is_empty() => folder.join(tail),
                    _ => folder,
                },
                None => home.join(candidate),
            }
        }
    };

    // Alternate data streams ("file.txt:secret") and device names are refused.
    let text = path.to_string_lossy();
    if text.chars().skip(2).any(|c| c == ':') || text.contains('*') || text.contains('?') || text.contains('<') || text.contains('>') || text.contains('|') {
        return Err("That path contains characters Windows does not allow.".to_owned());
    }
    Ok(path)
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

fn resolve_existing(raw: &str) -> Result<PathBuf, String> {
    let path = expand(raw)?;
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("{} does not exist.", display(&path)))?;
    Ok(strip_verbatim(canonical))
}

/// For paths that may not exist yet: the parent must exist; `..` is resolved through it.
fn resolve_target(raw: &str) -> Result<PathBuf, String> {
    let path = expand(raw)?;
    if path.exists() {
        return resolve_existing(raw);
    }
    if path.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err("Use a full path without \"..\" for new files and folders.".to_owned());
    }
    let parent = path.parent().ok_or("That path has no folder.")?;
    let name = path.file_name().ok_or("That path has no name.")?;
    let parent = parent
        .canonicalize()
        .map_err(|_| format!("The folder {} does not exist.", display(parent)))?;
    Ok(strip_verbatim(parent).join(name))
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".bak");
    path.with_file_name(name)
}

// ── Execution ─────────────────────────────────────────────────────────────────────────────

fn done(summary: impl Into<String>, output: Option<String>) -> Result<DesktopActionResult, String> {
    Ok(DesktopActionResult { ok: true, summary: summary.into(), output })
}

fn execute(action: Action) -> Result<DesktopActionResult, String> {
    match action {
        Action::OpenTarget { target, what } => {
            open_in_browser(&target)?;
            done(format!("Opened {what}."), None)
        }
        Action::ListDirectory { path } => {
            let mut rows = Vec::new();
            let mut total = 0usize;
            let entries = std::fs::read_dir(&path).map_err(|error| format!("Cannot read {}: {error}", display(&path)))?;
            for entry in entries.flatten() {
                total += 1;
                if rows.len() >= MAX_LIST_ENTRIES {
                    continue;
                }
                let meta = entry.metadata().ok();
                let kind = if meta.as_ref().is_some_and(|m| m.is_dir()) { "folder" } else { "file" };
                let size = meta.as_ref().filter(|m| m.is_file()).map(|m| m.len());
                let modified = meta
                    .and_then(|m| m.modified().ok())
                    .map(|time| chrono::DateTime::<chrono::Local>::from(time).format("%Y-%m-%d %H:%M").to_string());
                rows.push(json!({ "name": entry.file_name().to_string_lossy(), "kind": kind, "size": size, "modified": modified }));
            }
            let more = total.saturating_sub(rows.len());
            let output = json!({ "path": display(&path), "entries": rows, "more": more }).to_string();
            done(format!("Listed {} items in {}{}.", total, display(&path), if more > 0 { format!(" (showing {MAX_LIST_ENTRIES})") } else { String::new() }), Some(output))
        }
        Action::ReadTextFile { path, max_bytes } => {
            let mut file = std::fs::File::open(&path).map_err(|error| format!("Cannot open {}: {error}", display(&path)))?;
            let size = file.metadata().map(|m| m.len()).unwrap_or(0);
            let mut bytes = Vec::new();
            Read::take(&mut file, max_bytes).read_to_end(&mut bytes).map_err(|error| format!("Cannot read {}: {error}", display(&path)))?;
            if bytes.iter().take(8192).any(|b| *b == 0) {
                return Err(format!("{} looks like a binary file, not text.", display(&path)));
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let truncated = size > max_bytes;
            done(
                format!("Read {} ({} KB{}).", display(&path), bytes.len() / 1024, if truncated { ", first part only" } else { "" }),
                Some(text),
            )
        }
        Action::WriteTextFile { path, content, mode } => {
            match mode {
                WriteMode::Create => {
                    let mut file = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&path)
                        .map_err(|error| format!("Cannot create {}: {error}", display(&path)))?;
                    file.write_all(content.as_bytes()).map_err(|error| format!("Cannot write {}: {error}", display(&path)))?;
                    done(format!("Created {}.", display(&path)), None)
                }
                WriteMode::Overwrite => {
                    let mut note = String::new();
                    if path.exists() {
                        let backup = backup_path(&path);
                        std::fs::copy(&path, &backup).map_err(|error| format!("Cannot back up {}: {error}", display(&path)))?;
                        note = format!(" The old version is in {}.", display(&backup));
                    }
                    crate::util::atomic_write(&path, content.as_bytes())?;
                    done(format!("Saved {}.{note}", display(&path)), None)
                }
                WriteMode::Append => {
                    let mut file = std::fs::OpenOptions::new()
                        .append(true)
                        .create(true)
                        .open(&path)
                        .map_err(|error| format!("Cannot open {}: {error}", display(&path)))?;
                    file.write_all(content.as_bytes()).map_err(|error| format!("Cannot write {}: {error}", display(&path)))?;
                    done(format!("Added to {}.", display(&path)), None)
                }
            }
        }
        Action::MakeDirectory { path } => {
            std::fs::create_dir_all(&path).map_err(|error| format!("Cannot create {}: {error}", display(&path)))?;
            done(format!("Created the folder {}.", display(&path)), None)
        }
        Action::MovePath { from, to } => {
            if to.exists() {
                return Err(format!("{} already exists; nothing was moved.", display(&to)));
            }
            std::fs::rename(&from, &to).or_else(|_| {
                // Across drives rename fails: copy, then send the original to the Recycle Bin.
                copy_recursive(&from, &to, &mut 0)?;
                recycle(&from)
            }).map_err(|error| format!("Cannot move {}: {error}", display(&from)))?;
            done(format!("Moved {} to {}.", display(&from), display(&to)), None)
        }
        Action::CopyPath { from, to } => {
            if to.exists() {
                return Err(format!("{} already exists; nothing was copied.", display(&to)));
            }
            let mut count = 0usize;
            copy_recursive(&from, &to, &mut count).map_err(|error| format!("Cannot copy {}: {error}", display(&from)))?;
            done(format!("Copied {} to {} ({count} item{}).", display(&from), display(&to), if count == 1 { "" } else { "s" }), None)
        }
        Action::DeletePath { path } => {
            recycle(&path).map_err(|error| format!("Cannot recycle {}: {error}", display(&path)))?;
            done(format!("Moved {} to the Recycle Bin.", display(&path)), None)
        }
        Action::RunCommand { command, cwd, timeout_secs } => run_powershell(&command, &cwd, timeout_secs),
    }
}

fn copy_recursive(from: &Path, to: &Path, count: &mut usize) -> Result<(), String> {
    *count += 1;
    if *count > MAX_COPY_ENTRIES {
        return Err(format!("more than {MAX_COPY_ENTRIES} items"));
    }
    let meta = std::fs::symlink_metadata(from).map_err(|error| error.to_string())?;
    if meta.file_type().is_symlink() {
        return Ok(()); // never follow links out of the selected tree
    }
    if meta.is_dir() {
        std::fs::create_dir(to).map_err(|error| error.to_string())?;
        for entry in std::fs::read_dir(from).map_err(|error| error.to_string())?.flatten() {
            copy_recursive(&entry.path(), &to.join(entry.file_name()), count)?;
        }
        Ok(())
    } else {
        if to.exists() {
            return Err(format!("{} already exists", display(to)));
        }
        std::fs::copy(from, to).map(|_| ()).map_err(|error| error.to_string())
    }
}

#[cfg(windows)]
fn recycle(path: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    // pFrom is a list of NUL-terminated paths ending with an extra NUL.
    let mut from: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().collect();
    from.push(0);
    from.push(0);
    let flags = FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0 | FOF_WANTNUKEWARNING.0;
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: flags as u16,
        ..Default::default()
    };
    // SAFETY: `from` outlives the call and is double-NUL terminated as the API requires.
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 || op.fAnyOperationsAborted.as_bool() {
        return Err(format!("the Recycle Bin refused it (code {code})"));
    }
    if path.exists() {
        return Err("it is still there".to_owned());
    }
    Ok(())
}

#[cfg(not(windows))]
fn recycle(_path: &Path) -> Result<(), String> {
    Err("Moving to the trash is supported on Windows only.".to_owned())
}

fn run_powershell(command: &str, cwd: &Path, timeout_secs: u64) -> Result<DesktopActionResult, String> {
    let mut process = Command::new("powershell.exe");
    process
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    // Spawned into the app's job object: the command and everything it starts end with the app,
    // which also lets the kill switch stop it.
    let mut child = crate::job::spawn_in_job(&mut process).map_err(|error| format!("Cannot start PowerShell: {error}"))?;
    let stdout = child.stdout.take().ok_or("PowerShell output is unavailable.")?;
    let stderr = child.stderr.take().ok_or("PowerShell errors are unavailable.")?;
    let read_capped = |mut stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut kept = Vec::new();
            let mut chunk = [0u8; 8192];
            let mut dropped = 0usize;
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..n.min(room)]);
                dropped += n.saturating_sub(room);
            }
            (String::from_utf8_lossy(&kept).into_owned(), dropped)
        })
    };
    let out_reader = read_capped(Box::new(stdout));
    let err_reader = read_capped(Box::new(stderr));

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                // Kill the whole tree: commands often start child processes.
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("Lost track of PowerShell: {error}")),
        }
    };
    let (out, out_dropped) = out_reader.join().unwrap_or_default();
    let (err, err_dropped) = err_reader.join().unwrap_or_default();
    let code = status.and_then(|s| s.code());
    let mut output = String::new();
    if !out.trim().is_empty() {
        output.push_str(out.trim_end());
        if out_dropped > 0 {
            output.push_str(&format!("\n… ({out_dropped} more bytes not shown)"));
        }
    }
    if !err.trim().is_empty() {
        if !output.is_empty() {
            output.push_str("\n\n");
        }
        output.push_str("[errors]\n");
        output.push_str(err.trim_end());
        if err_dropped > 0 {
            output.push_str(&format!("\n… ({err_dropped} more bytes not shown)"));
        }
    }
    let ok = !timed_out && code == Some(0);
    let summary = if timed_out {
        format!("The command was stopped after {timeout_secs} seconds.")
    } else {
        format!("The command finished with exit code {}.", code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_owned()))
    };
    Ok(DesktopActionResult { ok, summary, output: if output.is_empty() { None } else { Some(output) } })
}

// ── Read-only queries ─────────────────────────────────────────────────────────────────────

fn start_menu_entries() -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(data) = std::env::var("ProgramData") {
        roots.push(PathBuf::from(data).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    fn walk(dir: &Path, depth: u32, out: &mut Vec<(String, PathBuf)>) {
        if depth > 4 || out.len() > 2000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, depth + 1, out);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("lnk") || e.eq_ignore_ascii_case("url"))
            {
                let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let lower = name.to_lowercase();
                if lower.contains("uninstall") || lower.contains("readme") || lower.contains("help") {
                    continue;
                }
                out.push((name, path));
            }
        }
    }
    for root in roots {
        walk(&root, 0, &mut found);
    }
    found.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    found.dedup_by(|a, b| a.0.eq_ignore_ascii_case(&b.0));
    found
}

fn best_app_match<'a>(apps: &'a [(String, PathBuf)], wanted: &str) -> Option<&'a (String, PathBuf)> {
    let wanted = wanted.trim().to_lowercase();
    apps.iter()
        .find(|(name, _)| name.to_lowercase() == wanted)
        .or_else(|| apps.iter().find(|(name, _)| name.to_lowercase().starts_with(&wanted)))
        .or_else(|| apps.iter().find(|(name, _)| name.to_lowercase().contains(&wanted)))
}

fn list_apps(query: Option<&str>) -> Result<DesktopActionResult, String> {
    let apps = start_menu_entries();
    let query = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let matches: Vec<&String> = apps
        .iter()
        .filter(|(name, _)| query.as_ref().is_none_or(|q| name.to_lowercase().contains(q)))
        .map(|(name, _)| name)
        .take(80)
        .collect();
    let summary = match &query {
        Some(q) => format!("Found {} app{} matching \"{q}\".", matches.len(), if matches.len() == 1 { "" } else { "s" }),
        None => format!("{} apps in the Start menu.", apps.len()),
    };
    done(summary, Some(json!({ "apps": matches }).to_string()))
}

fn system_info() -> Result<DesktopActionResult, String> {
    let mut info = serde_json::Map::new();
    info.insert("computer".into(), json!(std::env::var("COMPUTERNAME").ok()));
    info.insert("user".into(), json!(std::env::var("USERNAME").ok()));
    info.insert("cpu".into(), json!(registry_string(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString").map(|s| s.trim().to_owned())));
    info.insert("cores".into(), json!(std::thread::available_parallelism().map(|n| n.get()).ok()));
    let build = registry_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuild");
    let display_version = registry_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "DisplayVersion");
    let product = registry_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ProductName");
    // The registry still says "Windows 10" on Windows 11; the build number tells them apart.
    let os = match (&product, build.as_deref().and_then(|b| b.parse::<u32>().ok())) {
        (Some(name), Some(b)) if b >= 22000 => name.replace("Windows 10", "Windows 11"),
        (Some(name), _) => name.clone(),
        _ => "Windows".to_owned(),
    };
    info.insert("os".into(), json!(format!("{os}{}{}", display_version.map(|v| format!(" {v}")).unwrap_or_default(), build.map(|b| format!(" (build {b})")).unwrap_or_default())));
    info.insert("localTime".into(), json!(chrono::Local::now().format("%A %Y-%m-%d %H:%M").to_string()));
    windows_metrics(&mut info);
    let summary = format!(
        "{} · {}",
        info.get("os").and_then(Value::as_str).unwrap_or("Windows"),
        info.get("cpu").and_then(Value::as_str).unwrap_or("CPU")
    );
    done(summary, Some(Value::Object(info).to_string()))
}

#[cfg(windows)]
fn windows_metrics(info: &mut serde_json::Map<String, Value>) {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    // SAFETY: plain Win32 queries filling caller-owned structs.
    unsafe {
        let mut memory = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        if GlobalMemoryStatusEx(&mut memory).is_ok() {
            info.insert("memoryGB".into(), json!({
                "total": (memory.ullTotalPhys as f64 / GB * 10.0).round() / 10.0,
                "free": (memory.ullAvailPhys as f64 / GB * 10.0).round() / 10.0,
                "usedPercent": memory.dwMemoryLoad,
            }));
        }
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_owned()) + "\\";
        let root = HSTRING::from(drive.as_str());
        let (mut free, mut total) = (0u64, 0u64);
        if GetDiskFreeSpaceExW(PCWSTR(root.as_ptr()), Some(&mut free), Some(&mut total), None).is_ok() {
            info.insert("systemDrive".into(), json!({
                "drive": drive,
                "freeGB": (free as f64 / GB * 10.0).round() / 10.0,
                "totalGB": (total as f64 / GB * 10.0).round() / 10.0,
            }));
        }
        let mut power = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut power).is_ok() {
            info.insert("power".into(), json!({
                "pluggedIn": power.ACLineStatus == 1,
                "batteryPercent": if power.BatteryLifePercent <= 100 { Some(power.BatteryLifePercent) } else { None },
            }));
        }
        let minutes = GetTickCount64() / 60_000;
        info.insert("uptime".into(), json!(format!("{}h {}m", minutes / 60, minutes % 60)));
    }
}

#[cfg(not(windows))]
fn windows_metrics(_info: &mut serde_json::Map<String, Value>) {}

#[cfg(windows)]
fn registry_string(subkey: &str, value: &str) -> Option<String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let key = HSTRING::from(subkey);
    let name = HSTRING::from(value);
    let mut buffer = vec![0u16; 512];
    let mut size = (buffer.len() * 2) as u32;
    // SAFETY: buffer and size describe a caller-owned UTF-16 buffer.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status.0 != 0 {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1).min(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..len]).trim_end_matches('\0').to_owned())
}

#[cfg(not(windows))]
fn registry_string(_subkey: &str, _value: &str) -> Option<String> {
    None
}

// ── Screen capture ────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn screenshot() -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    // SAFETY: every GDI handle created here is released before returning.
    let (width, height, bgra) = unsafe {
        let width = GetSystemMetrics(SM_CXSCREEN);
        let height = GetSystemMetrics(SM_CYSCREEN);
        if width <= 0 || height <= 0 {
            return Err("The screen size is unavailable.".to_owned());
        }
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap.into());
        let blit = BitBlt(memory, 0, 0, width, height, Some(screen), 0, 0, SRCCOPY | CAPTUREBLT);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let lines = GetDIBits(memory, bitmap, 0, height as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        SelectObject(memory, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        blit.map_err(|error| format!("The screen could not be copied: {error}"))?;
        if lines == 0 {
            return Err("The screen image could not be read.".to_owned());
        }
        (width as usize, height as usize, pixels)
    };

    // Downscale (box filter) so the image stays small for the model.
    const MAX_W: usize = 1600;
    let (out_w, out_h, rgb) = if width > MAX_W {
        let out_w = MAX_W;
        let out_h = (height * MAX_W / width).max(1);
        let mut rgb = vec![0u8; out_w * out_h * 3];
        for y in 0..out_h {
            let y0 = y * height / out_h;
            let y1 = ((y + 1) * height / out_h).max(y0 + 1).min(height);
            for x in 0..out_w {
                let x0 = x * width / out_w;
                let x1 = ((x + 1) * width / out_w).max(x0 + 1).min(width);
                let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
                for sy in y0..y1 {
                    let row = sy * width * 4;
                    for sx in x0..x1 {
                        let i = row + sx * 4;
                        b += u32::from(bgra[i]);
                        g += u32::from(bgra[i + 1]);
                        r += u32::from(bgra[i + 2]);
                        n += 1;
                    }
                }
                let o = (y * out_w + x) * 3;
                rgb[o] = (r / n) as u8;
                rgb[o + 1] = (g / n) as u8;
                rgb[o + 2] = (b / n) as u8;
            }
        }
        (out_w, out_h, rgb)
    } else {
        let mut rgb = Vec::with_capacity(width * height * 3);
        for px in bgra.chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        (width, height, rgb)
    };

    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, out_w as u32, out_h as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|error| format!("Cannot encode the screenshot: {error}"))?;
        writer.write_image_data(&rgb).map_err(|error| format!("Cannot encode the screenshot: {error}"))?;
    }
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(png_bytes)))
}

#[cfg(not(windows))]
fn screenshot() -> Result<String, String> {
    Err("Screen capture is implemented for Windows only.".to_owned())
}

// ── Audit log ─────────────────────────────────────────────────────────────────────────────

fn audit(app: &tauri::AppHandle, mut entry: Value) {
    let Ok(dir) = app_data_dir(app) else { return };
    if let Value::Object(map) = &mut entry {
        map.insert("at".into(), json!(now_ms()));
    }
    let path = dir.join("desktop-audit.jsonl");
    // Keep the log bounded: when it passes 2 MB, keep the newest half.
    if std::fs::metadata(&path).map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(false) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let lines: Vec<&str> = text.lines().collect();
            let keep = lines[lines.len() / 2..].join("\n") + "\n";
            let _ = crate::util::atomic_write(&path, keep.as_bytes());
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{entry}");
    }
}
