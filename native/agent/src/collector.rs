use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, SyncSender, TrySendError},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use walkdir::WalkDir;

use crate::{
    config::AgentConfig,
    reasoner,
    store::{EventRecord, Store},

};

#[derive(Debug, Default)]
pub struct ScanReport {
    pub files_seen: u64,
    pub resources_discovered: u64,
    pub resources_changed: u64,
    pub inaccessible_entries: u64,
}

fn file_modified_ms(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
}

pub fn scan_roots(config: &AgentConfig, store: &mut Store) -> Result<ScanReport> {
    let mut report = ScanReport::default();

    for root in &config.consent.allowed_roots {
        let root_text = root.to_string_lossy().into_owned();
        for entry in WalkDir::new(root).follow_links(false).into_iter() {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    report.inaccessible_entries += 1;
                    eprintln!("[coverage] Could not inspect one entry: {error}");
                    continue;
                }
            };

            if entry.file_type().is_symlink() || !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            let metadata = match fs::metadata(path) {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) => continue,
                Err(error) => {
                    report.inaccessible_entries += 1;
                    eprintln!("[coverage] Metadata unavailable for {}: {error}", path.display());
                    continue;
                }
            };

            report.files_seen += 1;
            let resource_path = path.to_string_lossy().into_owned();
            match store.observe_file(
                &root_text,
                &resource_path,
                metadata.len(),
                file_modified_ms(&metadata),
                "initial_inventory",
            )? {
                1 => report.resources_discovered += 1,
                2 => report.resources_changed += 1,
                _ => {}
            }
        }
    }
    Ok(report)
}

fn path_is_authorized(path: &Path, roots: &[PathBuf]) -> bool {
    path.is_absolute() && roots.iter().any(|root| path.starts_with(root))
}

fn enqueue_notification(
    sender: &SyncSender<notify::Result<Event>>,
    overflowed: &AtomicBool,
    notification: notify::Result<Event>,
) {
    if let Err(TrySendError::Full(_)) = sender.try_send(notification) {
        overflowed.store(true, Ordering::Release);
    }
}

fn process_notification(event: Event, roots: &[PathBuf], store: &mut Store) -> Result<usize> {
    if matches!(&event.kind, EventKind::Access(_)) || event.paths.is_empty() {
        return Ok(0);
    }

    let event_kind = format!("{:?}", event.kind);
    let is_remove = matches!(&event.kind, EventKind::Remove(_));
    let mut processed = 0;

    for path in event.paths {
        if !path_is_authorized(&path, roots) {
            continue;
        }

        let path_text = path.to_string_lossy().into_owned();
        let metadata = match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                let modified = file_modified_ms(&metadata);
                if let Some(root) = roots.iter().find(|root| path.starts_with(root)) {
                    let root_text = root.to_string_lossy().into_owned();
                    store.observe_file(
                        &root_text,
                        &path_text,
                        metadata.len(),
                        modified,
                        "filesystem_watcher",
                    )?;
                }
                Some((metadata.len(), modified))
            }
            _ => {
                if is_remove {
                    store.mark_resource_inactive(&path_text)?;
                }
                None
            }
        };

        store.record_notification(&event_kind, &path_text, metadata)?;
        processed += 1;
    }
    Ok(processed)
}

fn evaluate_context(store: &mut Store, config: &AgentConfig) -> Result<Option<reasoner::Decision>> {
    let Some(reasoner_config) = &config.reasoner else {
        return Ok(None);
    };

    let cursor = store.last_decision_sequence()?;
    let evidence: Vec<EventRecord> = store.events_after(cursor, 100)?;
    if evidence.is_empty() {
        return Ok(None);
    }

    let through_seq = evidence.last().map(|event| event.seq).unwrap_or(cursor);
    let decision = reasoner::evaluate(reasoner_config, &evidence, &config.approved_note_roots)?;
    
    if let Some(action) = &decision.proposed_action {
        let payload = serde_json::to_value(&action.payload)?;
        let action_id = store.create_pending_action(
            through_seq,
            &action.description,
            &payload,
            &decision.evidence_event_ids,
        )?;
        println!("[MISS MINUTES / APPROVAL REQUIRED] action={action_id}: {}", action.description);
    }

    let decision_json = serde_json::to_value(&decision)?;
    store.record_decision(through_seq, &decision_json)?;

    match decision.decision {
        reasoner::DecisionKind::Speak => {
            if let Some(message) = &decision.message {
                println!("[MISS MINUTES / SPEAK CANDIDATE] {message}");
            }
        }
        reasoner::DecisionKind::ProposeAction => {
            // The typed proposal is durably queued above. It has no execution path
            // until an owner approves the exact payload in the desktop UI or CLI.
        }
        reasoner::DecisionKind::Silent => {
            println!("[MISS MINUTES / SILENT] {}", decision.reasoning);
        }
    }
    Ok(Some(decision))
}

pub fn run_agent(config: &AgentConfig, quiet_window_seconds: u64, rescan_seconds: u64) -> Result<()> {
    let stopping = Arc::new(AtomicBool::new(false));
    let signal_stopping = Arc::clone(&stopping);
    ctrlc::set_handler(move || {
        signal_stopping.store(true, Ordering::Release);
    }).context("Cannot register shutdown handler")?;
    run_agent_until(config, quiet_window_seconds, rescan_seconds, stopping)
}

/// Run under an externally managed shutdown token. Desktop hosts use this
/// entry point instead of installing a process-global Ctrl+C handler.
pub fn run_agent_until(
    config: &AgentConfig,
    quiet_window_seconds: u64,
    rescan_seconds: u64,
    stopping: Arc<AtomicBool>,
) -> Result<()> {
    run_agent_until_with_callback(config, quiet_window_seconds, rescan_seconds, stopping, |_| {})
}

/// Variant used by the native host to forward validated reasoning decisions to
/// the character event bus. The callback runs on the collector worker thread.
pub fn run_agent_until_with_callback<F>(
    config: &AgentConfig,
    quiet_window_seconds: u64,
    rescan_seconds: u64,
    stopping: Arc<AtomicBool>,
    mut on_decision: F,
) -> Result<()>
where
    F: FnMut(&reasoner::Decision),
{
    let roots = config.consent.allowed_roots.clone();
    let (sender, receiver) = mpsc::sync_channel::<notify::Result<Event>>(2048);
    let overflowed = Arc::new(AtomicBool::new(false));
    let callback_overflow = Arc::clone(&overflowed);
    let callback_sender = sender.clone();

    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |notification| {
        enqueue_notification(&callback_sender, &callback_overflow, notification);
    }).context("Cannot initialize this platform's file-system watcher")?;

    for root in &roots {
        watcher.watch(root, RecursiveMode::Recursive)
            .with_context(|| format!("Cannot watch authorized root {}", root.display()))?;
    }

    let mut store = Store::open(&config.database_path)?;
    let recovered_actions = store.recover_interrupted_actions()?;
    let deleted = store.prune_expired(config.retention_days)?;
    let initial = scan_roots(config, &mut store)?;
    println!(
        "[agent] Running. Roots: {}. Files observed: {}. New: {}. Changed: {}. Inaccessible: {}. Expired events removed: {}.",
        roots.len(),
        initial.files_seen,
        initial.resources_discovered,
        initial.resources_changed,
        initial.inaccessible_entries,
        deleted
    );
    println!("[agent] Metadata only. File contents, keystrokes, clipboard, screenshots and private app data are not collected.");
    if recovered_actions > 0 {
        eprintln!("[actions] Marked {recovered_actions} interrupted action(s) failed for manual inspection; no automatic retry was attempted.");
    }

    let quiet_window = Duration::from_secs(quiet_window_seconds.clamp(5, 3600));
    let rescan_interval = Duration::from_secs(rescan_seconds.clamp(30, 86_400));
    let mut next_rescan = Instant::now() + rescan_interval;
    let mut last_event_at: Option<Instant> = if initial.resources_discovered > 0 || initial.resources_changed > 0 {
        Some(Instant::now())
    } else {
        None
    };
    let mut last_reasoner_error_at: Option<Instant> = None;

    while !stopping.load(Ordering::Acquire) {
        match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(Ok(event)) => {
                match process_notification(event, &roots, &mut store) {
                    Ok(processed) if processed > 0 => last_event_at = Some(Instant::now()),
                    Ok(_) => {}
                    Err(error) => eprintln!("[collector] Notification could not be stored: {error:#}"),
                }
            }
            Ok(Err(error)) => {
                let payload = serde_json::json!({
                    "error": error.to_string(),
                    "coverage": "A watcher error was observed; activity may be missing."
                });
                let _ = store.append_event(
                    "filesystem_watcher",
                    "collector.notification_error",
                    None,
                    "agent_observed_at",
                    None,
                    &payload,
                );
                last_event_at = Some(Instant::now());
                eprintln!("[collector] Watcher reported an error: {error}");
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                anyhow::bail!("File-system event channel disconnected; stopping to avoid silent data loss.");
            }
        }

        if overflowed.swap(false, Ordering::AcqRel) {
            let payload = serde_json::json!({
                "reason": "bounded_notification_queue_overflow",
                "recovery": "A metadata rescan will run, but individual event detail may be missing.",
                "complete_history": false
            });
            store.append_event(
                "filesystem_watcher",
                "collector.coverage_gap",
                None,
                "agent_observed_at",
                None,
                &payload,
            )?;
            eprintln!("[coverage] Notification queue overflowed. A rescan cannot reconstruct every missed event.");
            let report = scan_roots(config, &mut store)?;
            eprintln!("[collector] Recovery scan: {} files, {} inaccessible entries.", report.files_seen, report.inaccessible_entries);
            last_event_at = Some(Instant::now());
        }

        if Instant::now() >= next_rescan {
            let report = scan_roots(config, &mut store)?;
            eprintln!(
                "[collector] Periodic metadata reconciliation: {} files observed, {} new, {} changed, {} inaccessible.",
                report.files_seen,
                report.resources_discovered,
                report.resources_changed,
                report.inaccessible_entries
            );
            next_rescan = Instant::now() + rescan_interval;
            if report.resources_discovered > 0 || report.resources_changed > 0 || report.inaccessible_entries > 0 {
                last_event_at = Some(Instant::now());
            }
        }

        if last_event_at.is_some_and(|last| last.elapsed() >= quiet_window) {
            if config.reasoner.is_some() {
                match evaluate_context(&mut store, config) {
                    Ok(Some(decision)) => {
                        last_reasoner_error_at = None;
                        on_decision(&decision);
                    }
                    Ok(None) => last_reasoner_error_at = None,
                    Err(error) => {
                        eprintln!("[reasoner] No decision recorded: {error:#}");
                        last_reasoner_error_at = Some(Instant::now());
                    }
                }
            }
            last_event_at = if last_reasoner_error_at.is_some() {
                Some(Instant::now())
            } else {
                None
            };
        }
    }

    drop(watcher);
    println!("[agent] Stopped cleanly.");
    Ok(())
}

pub fn run_one_reasoning_cycle(config: &AgentConfig) -> Result<bool> {
    let mut store = Store::open(&config.database_path)?;
    evaluate_context(&mut store, config).map(|decision| decision.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_is_path_scoped() {
        let approved_root = std::env::temp_dir().join("miss-minute-authorization-approved");
        let approved_file = approved_root.join("file.txt");
        let sibling_file = std::env::temp_dir()
            .join("miss-minute-authorization-approved-sibling")
            .join("file.txt");
        let roots = vec![approved_root];

        assert!(path_is_authorized(&approved_file, &roots));
        assert!(!path_is_authorized(&sibling_file, &roots));
        assert!(!path_is_authorized(Path::new("relative/file.txt"), &roots));
    }
}
