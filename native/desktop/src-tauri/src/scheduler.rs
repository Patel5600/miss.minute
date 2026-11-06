//! Native alarm clock. The dashboard keeps the next 48 hours of timers, alarms and reminders
//! synced here (`schedule_sync`), and a host thread fires them even while the dashboard
//! window is hidden: a Windows notification, Miss Minutes speaking on the desktop overlay,
//! and a `miss-minutes:alarm` event to both windows.
//!
//! Pending alerts are persisted, so an alert that came due while the app was closed still
//! fires at the next launch when it is less than ten minutes late.

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::util::{app_data_dir, atomic_write, now_ms};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledAlert {
    pub id: String,
    pub title: String,
    pub body: Option<String>,
    /// timer | reminder | alarm | event
    pub kind: String,
    pub at_unix_ms: i64,
    /// What the avatar says when it fires.
    pub speech: Option<String>,
}

const MAX_ALERTS: usize = 500;
const HORIZON_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const LATE_LIMIT_MS: i64 = 10 * 60 * 1000;
const MAX_TITLE: usize = 200;
const MAX_TEXT: usize = 1000;

#[derive(Default)]
struct Book {
    pending: Vec<ScheduledAlert>,
    /// Ids already delivered, so a re-sync of the same occurrence never fires twice.
    fired: HashSet<String>,
    path: Option<PathBuf>,
}

fn book() -> &'static Mutex<Book> {
    static BOOK: OnceLock<Mutex<Book>> = OnceLock::new();
    BOOK.get_or_init(|| Mutex::new(Book::default()))
}

fn persist(book: &Book) {
    if let Some(path) = &book.path {
        if let Ok(bytes) = serde_json::to_vec(&book.pending) {
            let _ = atomic_write(path, &bytes);
        }
    }
}

/// Replaces the full set of pending alerts.
#[tauri::command]
pub fn schedule_sync(alerts: Vec<ScheduledAlert>, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::require_dashboard(&window)?;
    if alerts.len() > MAX_ALERTS {
        return Err(format!("At most {MAX_ALERTS} alerts can be scheduled."));
    }
    let now = now_ms();
    let mut clean = Vec::with_capacity(alerts.len());
    for mut alert in alerts {
        if alert.id.is_empty() || alert.id.len() > 200 || alert.at_unix_ms > now + HORIZON_MS || alert.at_unix_ms < now - LATE_LIMIT_MS {
            continue;
        }
        if !matches!(alert.kind.as_str(), "timer" | "reminder" | "alarm" | "event") {
            continue;
        }
        alert.title = truncate(&alert.title, MAX_TITLE);
        alert.body = alert.body.map(|b| truncate(&b, MAX_TEXT));
        alert.speech = alert.speech.map(|s| truncate(&s, MAX_TEXT));
        if alert.title.trim().is_empty() {
            continue;
        }
        clean.push(alert);
    }
    let mut book = book().lock().map_err(|_| "The alarm clock is unavailable.".to_owned())?;
    book.pending = clean.into_iter().filter(|a| !book.fired.contains(&a.id)).collect();
    persist(&book);
    Ok(())
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Starts the alarm thread. Call once from setup().
pub fn start(app: tauri::AppHandle) {
    {
        let Ok(mut book) = book().lock() else { return };
        if let Ok(dir) = app_data_dir(&app) {
            let path = dir.join("scheduled-alerts.json");
            if let Ok(bytes) = std::fs::read(&path) {
                if let Ok(saved) = serde_json::from_slice::<Vec<ScheduledAlert>>(&bytes) {
                    book.pending = saved;
                }
            }
            book.path = Some(path);
        }
    }
    let _ = std::thread::Builder::new().name("miss-minutes-alarms".to_owned()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let now = now_ms();
        let due: Vec<ScheduledAlert> = {
            let Ok(mut book) = book().lock() else { continue };
            if !book.pending.iter().any(|a| a.at_unix_ms <= now) {
                continue;
            }
            let (due, keep): (Vec<_>, Vec<_>) = book.pending.drain(..).partition(|a| a.at_unix_ms <= now);
            book.pending = keep;
            for alert in &due {
                book.fired.insert(alert.id.clone());
            }
            if book.fired.len() > 5_000 {
                book.fired.clear();
            }
            persist(&book);
            due
        };
        for alert in due {
            if now - alert.at_unix_ms > LATE_LIMIT_MS {
                continue; // too old to announce; the dashboard records it as missed
            }
            fire(&app, &alert);
        }
    });
}

fn fire(app: &tauri::AppHandle, alert: &ScheduledAlert) {
    let _ = app
        .notification()
        .builder()
        .title(&alert.title)
        .body(alert.body.clone().unwrap_or_default())
        .show();

    let speech = alert.speech.clone().unwrap_or_else(|| alert.title.clone());
    if let Some(state) = app.try_state::<crate::DesktopState>() {
        let utterance = crate::AvatarUtterance {
            text: speech,
            emotion: "surprised".to_owned(),
            gesture: Some("wave".to_owned()),
            pitch: 1.12,
            rate: 1.0,
            eleven_labs_key: None,
            eleven_labs_voice_id: None,
        };
        let _ = state.speak_on_avatar(app, utterance, "conversational");
    }
    let _ = app.emit_to("main", "miss-minutes:alarm", alert);
    let _ = app.emit_to("avatar", "miss-minutes:alarm", alert);
}
