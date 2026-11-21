use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::Engine as _;
use miss_minute_agent::{
    actions::{ActionExecutionResult, approve_and_execute},
    collector::run_agent_until_with_callback,
    config::{
        authorize_note_root as grant_note_root, configure_auto_note_creation,
        configure_foreground_window_title, create_config, load_config,
        revoke_note_root as drop_note_root,
    },
    reasoner::DecisionKind,
    store::{PendingActionRecord, Store},
};
use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use uuid::Uuid;

mod chatgpt;
mod crypto;
mod desktop_tools;
mod job;
mod loopback;
mod openrouter;
mod owner;
mod owner_data;
mod provider;
mod scheduler;
mod util;
mod voice;
use voice::{VoiceHost, VoiceStatus};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AvatarBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct AgentRuntime {
    shutdown: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    last_error: Arc<Mutex<Option<String>>>,
}

struct DesktopState {
    config_path: PathBuf,
    owner_data_dir: PathBuf,
    owner: Mutex<owner::DesktopAuthority>,
    owner_db: Mutex<Option<owner_data::OwnerDataDb>>,
    agent: Mutex<Option<AgentRuntime>>,
    avatar_bounds: Arc<Mutex<AvatarBounds>>,
    avatar_dragging: Arc<AtomicBool>,
    stream_session: Mutex<Option<AgentStreamSession>>,
    voice: VoiceHost,
    /// Owner preference: speak through the local voice engine when it is ready.
    prefer_local_voice: AtomicBool,
    started_at: Instant,
    agent_kill: Arc<AtomicBool>,
    wake: Mutex<mm_wake::WakeEngine>,
    telemetry: Mutex<mm_telemetry::TelemetryRegistry>,
}

impl DesktopState {
    fn new(config_path: PathBuf, owner_data_dir: PathBuf) -> Result<Self, String> {
        let wake = mm_wake::WakeEngine::new(mm_wake::WakeConfig::default())
            .map_err(|error| format!("Cannot initialize wake engine: {error}"))?;
        Ok(Self {
            config_path,
            owner: Mutex::new(owner::DesktopAuthority::load(owner_data_dir.clone())?),
            owner_data_dir,
            owner_db: Mutex::new(None),
            agent: Mutex::new(None),
            avatar_bounds: Arc::new(Mutex::new(AvatarBounds::default())),
            avatar_dragging: Arc::new(AtomicBool::new(false)),
            stream_session: Mutex::new(None),
            voice: VoiceHost::new(),
            prefer_local_voice: AtomicBool::new(false),
            started_at: Instant::now(),
            agent_kill: Arc::new(AtomicBool::new(false)),
            wake: Mutex::new(wake),
            telemetry: Mutex::new(mm_telemetry::TelemetryRegistry::new()),
        })
    }

    fn monotonic_ms(&self) -> u64 {
        u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Single path for everything the avatar says. Prefers the local voice engine when the
    /// owner enabled it and it is ready; otherwise (or if it fails) falls back to the
    /// overlay's own speech, so a missing engine never silences her.
    fn speak_on_avatar(
        &self,
        app: &tauri::AppHandle,
        utterance: AvatarUtterance,
        style: &str,
    ) -> Result<(), String> {
        if self.prefer_local_voice.load(Ordering::Acquire) && self.voice.is_ready() {
            let id = Uuid::new_v4().to_string();
            match self.voice.speak(&id, &utterance.text, style, "avatar") {
                Ok(()) => {
                    return app
                        .emit_to(
                            "avatar",
                            "miss-minutes:speak-local",
                            serde_json::json!({
                                "id": id,
                                "emotion": utterance.emotion,
                                "gesture": utterance.gesture,
                            }),
                        )
                        .map_err(|error| format!("Cannot send speech to avatar window: {error}"));
                }
                Err(error) => {
                    eprintln!("[voice] Local voice unavailable, using system speech: {error}")
                }
            }
        }
        app.emit_to("avatar", "miss-minutes:speak", utterance)
            .map_err(|error| format!("Cannot send speech to avatar window: {error}"))
    }

    fn stop_agent(&self) {
        if let Ok(mut slot) = self.agent.lock()
            && let Some(mut runtime) = slot.take()
        {
            runtime.shutdown.store(true, Ordering::Release);
            if let Some(join) = runtime.join.take() {
                let _ = join.join();
            }
        }
    }

    fn start_agent(&self, app: tauri::AppHandle) -> Result<(), String> {
        if self.agent_kill.load(Ordering::Acquire) {
            return Err(
                "Emergency kill switch is active. Unlock with Windows Hello before restarting the local agent."
                    .to_owned(),
            );
        }
        let config = load_config(&self.config_path).map_err(|error| format!("{error:#}"))?;
        let mut slot = self
            .agent
            .lock()
            .map_err(|_| "Agent state is unavailable".to_owned())?;

        if let Some(runtime) = slot.as_ref()
            && runtime
                .join
                .as_ref()
                .is_some_and(|join| !join.is_finished())
        {
            return Ok(());
        }
        if let Some(mut previous) = slot.take()
            && let Some(join) = previous.join.take()
        {
            let _ = join.join();
        }

        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = Arc::clone(&shutdown);
        let last_error = Arc::new(Mutex::new(None));
        let worker_error = Arc::clone(&last_error);
        let event_app = app.clone();

        let join = std::thread::Builder::new()
            .name("miss-minutes-agent".to_owned())
            .spawn(move || {
                let speech_app = event_app.clone();
                let result = run_agent_until_with_callback(
                    &config,
                    45,
                    300,
                    worker_shutdown,
                    move |decision| {
                        if let (DecisionKind::Speak, Some(message)) =
                            (decision.decision, decision.message.as_ref())
                        {
                            let utterance = AvatarUtterance {
                                text: message.clone(),
                                emotion: "winking".to_owned(),
                                gesture: None,
                                pitch: 1.12,
                                rate: 1.0,
                                eleven_labs_key: None,
                                eleven_labs_voice_id: None,
                            };
                            if let Some(state) = speech_app.try_state::<DesktopState>() {
                                let _ =
                                    state.speak_on_avatar(&speech_app, utterance, "conversational");
                            }
                        }
                    },
                );
                if let Err(error) = result
                    && let Ok(mut slot) = worker_error.lock()
                {
                    *slot = Some(format!("{error:#}"));
                }
            })
            .map_err(|error| format!("Cannot start native agent: {error}"))?;

        *slot = Some(AgentRuntime {
            shutdown,
            join: Some(join),
            last_error,
        });
        Ok(())
    }

    fn agent_running(&self) -> bool {
        self.agent
            .lock()
            .ok()
            .and_then(|slot| {
                slot.as_ref().map(|runtime| {
                    runtime
                        .join
                        .as_ref()
                        .is_some_and(|join| !join.is_finished())
                })
            })
            .unwrap_or(false)
    }
}

/// Checks the native owner session at the point a typed model/tool request crosses into the host.
/// Renderer state and model output never establish identity.
pub(crate) fn require_capability(state: &DesktopState, capability: &str) -> Result<(), String> {
    let mut authority = state
        .owner
        .lock()
        .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
    authority.authorize(
        capability,
        miss_minute_identity::CommandOrigin::Model,
        miss_minute_identity::Risk::Low,
        false,
    )
}

/// User initiated host operations use the same centralized policy, with an explicit origin.
pub(crate) fn require_owner_capability(
    window: &tauri::WebviewWindow,
    capability: &str,
) -> Result<(), String> {
    require_dashboard(window)?;
    let state = window
        .try_state::<DesktopState>()
        .ok_or_else(|| "Desktop authority state is unavailable.".to_owned())?;
    let mut authority = state
        .owner
        .lock()
        .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
    authority.authorize(
        capability,
        miss_minute_identity::CommandOrigin::UserInput,
        miss_minute_identity::Risk::Low,
        false,
    )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    enrolled: bool,
    running: bool,
    roots: Vec<String>,
    events: i64,
    indexed_files: i64,
    decisions: i64,
    last_error: Option<String>,
    approved_note_roots: Vec<String>,
    pending_actions: i64,
    auto_create_notes: bool,
    foreground_window_context_enabled: bool,
    foreground_window_context_supported: bool,
    automatic_actions_today: i64,
    daily_note_limit: u8,
}

fn agent_status_inner(state: &DesktopState) -> AgentStatus {
    let mut status = AgentStatus {
        enrolled: state.config_path.is_file(),
        running: state.agent_running(),
        roots: Vec::new(),
        events: 0,
        indexed_files: 0,
        decisions: 0,
        last_error: None,
        approved_note_roots: Vec::new(),
        pending_actions: 0,
        auto_create_notes: false,
        foreground_window_context_enabled: false,
        foreground_window_context_supported: cfg!(windows),
        automatic_actions_today: 0,
        daily_note_limit: 3,
    };

    if let Ok(slot) = state.agent.lock()
        && let Some(runtime) = slot.as_ref()
    {
        status.last_error = runtime
            .last_error
            .lock()
            .ok()
            .and_then(|value| value.clone());
    }

    if let Ok(config) = load_config(&state.config_path) {
        status.roots = config
            .consent
            .allowed_roots
            .iter()
            .map(|root| root.display().to_string())
            .collect();
        status.approved_note_roots = config
            .approved_note_roots
            .iter()
            .map(|root| root.display().to_string())
            .collect();
        status.auto_create_notes = config.automation.auto_create_notes;
        status.foreground_window_context_enabled = config.capture.foreground_window_title;
        status.daily_note_limit = config.automation.max_notes_per_utc_day;

        if let Ok(store) = Store::open(&config.database_path) {
            const DAY_MS: i64 = 86_400_000;
            let now = miss_minute_agent::config::now_unix_ms();
            let day_start = now.div_euclid(DAY_MS) * DAY_MS;
            if let Ok(count) = store.automatic_actions_since(day_start) {
                status.automatic_actions_today = count;
            }
            if let Ok((events, files, decisions)) = store.counts() {
                status.events = events;
                status.indexed_files = files;
                status.decisions = decisions;
            }
            if let Ok(count) = store.pending_action_count() {
                status.pending_actions = count;
            }
        }
    }
    status
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStreamTicket {
    token: String,
    cursor: i64,
    expires_at_unix_ms: u64,
}

struct AgentStreamSession {
    token: String,
    expires_at: Instant,
    acknowledged_cursor: i64,
    issued_cursor: i64,
}

fn require_dashboard(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("This operation is restricted to the dashboard window.".to_owned());
    }
    Ok(())
}

fn emit_owner_state(app: &tauri::AppHandle, status: &owner::OwnerStatus) {
    let _ = app.emit_to("main", "miss-minutes:owner-state", status);
}

fn clear_unlocked_handles(state: &DesktopState) {
    if let Ok(mut session) = state.stream_session.lock() {
        *session = None;
    }
    if let Ok(mut db) = state.owner_db.lock() {
        *db = None;
    }
}

pub(crate) fn lock_and_clear_owner_state(app: &tauri::AppHandle) -> Option<owner::OwnerStatus> {
    let state = app.try_state::<DesktopState>()?;
    clear_unlocked_handles(&state);
    let status = state.owner.lock().ok().map(|mut authority| {
        authority.lock();
        authority.status()
    });
    if let Some(status) = &status {
        emit_owner_state(app, status);
    }
    status
}

#[tauri::command]
fn owner_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<owner::OwnerStatus, String> {
    require_dashboard(&window)?;
    let mut authority = state
        .owner
        .lock()
        .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
    Ok(authority.status())
}

#[tauri::command]
fn owner_enroll(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<owner::OwnerStatus, String> {
    require_dashboard(&window)?;
    let result = {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        authority.enroll(&window)
    };
    if let Ok(status) = &result {
        emit_owner_state(&app, status);
    }
    result
}

#[tauri::command]
fn owner_authenticate(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<owner::OwnerStatus, String> {
    require_dashboard(&window)?;
    let (result, fallback_status) = {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        let res = authority.authenticate(&window);
        let current = authority.status();
        (res, current)
    };
    match &result {
        Ok(status) => {
            if status.authenticated {
                state.agent_kill.store(false, Ordering::Release);
            }
            emit_owner_state(&app, status);
        }
        Err(_) => {
            if !fallback_status.authenticated {
                clear_unlocked_handles(&state);
            }
            emit_owner_state(&app, &fallback_status);
        }
    }
    result
}

#[tauri::command]
fn owner_lock(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<owner::OwnerStatus, String> {
    require_dashboard(&window)?;
    clear_unlocked_handles(&state);
    let status = {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        authority.lock();
        authority.status()
    };
    emit_owner_state(&app, &status);
    Ok(status)
}

#[tauri::command]
fn owner_candidate_signal(
    signal: String,
    confidence: f32,
    liveness_passed: Option<bool>,
    engaged: Option<bool>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<owner::OwnerStatus, String> {
    require_dashboard(&window)?;
    let status = {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        authority.record_candidate_signal(
            &signal,
            confidence,
            liveness_passed.unwrap_or(false),
            engaged.unwrap_or(false),
        )?
    };
    emit_owner_state(&app, &status);
    Ok(status)
}

#[tauri::command]
fn owner_step_up_authenticate(
    action_name: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<owner::OwnerStatus, String> {
    require_dashboard(&window)?;
    let (result, current) = {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        let res = authority.step_up_authenticate(&window, &action_name);
        let status = authority.status();
        (res, status)
    };
    if !current.authenticated {
        clear_unlocked_handles(&state);
    }
    match &result {
        Ok(status) => {
            if status.authenticated {
                state.agent_kill.store(false, Ordering::Release);
            }
            emit_owner_state(&app, status);
        }
        Err(_) => emit_owner_state(&app, &current),
    }
    result
}

#[tauri::command]
fn owner_mode_get(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<miss_minute_identity::OperatingMode, String> {
    require_dashboard(&window)?;
    let mut authority = state
        .owner
        .lock()
        .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
    Ok(authority.status().mode)
}

#[tauri::command]
fn owner_pair_android(
    request_json: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<String, String> {
    require_dashboard(&window)?;
    let mut authority = state
        .owner
        .lock()
        .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
    authority.authorize(
        miss_minute_identity::capabilities::OWNER_PROFILE_MODIFY,
        miss_minute_identity::CommandOrigin::UserInput,
        miss_minute_identity::Risk::Low,
        false,
    )?;
    authority.approve_android_pairing(&window, &request_json)
}

#[tauri::command]
fn owner_recover_android_kit(
    material: String,
    passphrase: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<owner::OwnerStatus, String> {
    require_dashboard(&window)?;
    let result = {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        authority.recover_with_android_kit(&window, &material, &passphrase)
    };
    if let Ok(status) = &result {
        emit_owner_state(&app, status);
    }
    result
}

#[tauri::command]
fn agent_stream_open(
    after_seq: Option<i64>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<AgentStreamTicket, String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_FILES_READ,
    )?;
    if after_seq.is_some_and(|cursor| cursor < 0) {
        return Err("Event cursor must be non-negative.".to_owned());
    }
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    let latest = store
        .last_event_sequence()
        .map_err(|error| format!("{error:#}"))?;
    let cursor = after_seq.unwrap_or(latest);
    if cursor > latest {
        return Err("Event cursor is ahead of the committed event ledger.".to_owned());
    }
    let oldest = store
        .oldest_event_sequence()
        .map_err(|error| format!("{error:#}"))?;
    if after_seq.is_some()
        && (oldest.is_some_and(|first| cursor < first.saturating_sub(1))
            || (oldest.is_none() && cursor < latest))
    {
        return Err("Event retention gap: requested history has already been pruned. Reopen at the current cursor.".to_owned());
    }
    let token = Uuid::new_v4().to_string();
    let expires_at = Instant::now() + Duration::from_secs(30 * 60);
    let expires_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is before the Unix epoch.".to_owned())?
        .as_millis()
        .saturating_add(30 * 60 * 1000)
        .min(u64::MAX as u128) as u64;
    let mut session = state
        .stream_session
        .lock()
        .map_err(|_| "Event stream state is unavailable.".to_owned())?;
    *session = Some(AgentStreamSession {
        token: token.clone(),
        expires_at,
        acknowledged_cursor: cursor,
        issued_cursor: cursor,
    });
    Ok(AgentStreamTicket {
        token,
        cursor,
        expires_at_unix_ms,
    })
}

#[tauri::command]
fn agent_events_after(
    token: String,
    after_seq: i64,
    limit: usize,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<Vec<miss_minute_agent::store::EventRecord>, String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_FILES_READ,
    )?;
    if after_seq < 0 || limit == 0 || limit > 100 {
        return Err(
            "Event cursor must be non-negative and page size must be between 1 and 100.".to_owned(),
        );
    }
    // Serialize reads for a stream. A page remains repeatable until its
    // final sequence is acknowledged, giving the renderer at-least-once delivery.
    let mut session = state
        .stream_session
        .lock()
        .map_err(|_| "Event stream state is unavailable.".to_owned())?;
    let active = session
        .as_mut()
        .ok_or_else(|| "Open an event stream before reading it.".to_owned())?;
    if active.expires_at <= Instant::now() || active.token != token {
        return Err("Event stream token is invalid or expired; open a new session.".to_owned());
    }
    if after_seq != active.acknowledged_cursor {
        return Err("Event cursor must match the last acknowledged sequence.".to_owned());
    }
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    let batch = store
        .events_after(after_seq, limit)
        .map_err(|error| format!("{error:#}"))?;
    if let Some(last) = batch.last() {
        active.issued_cursor = last.seq;
    }
    Ok(batch)
}

#[tauri::command]
fn agent_stream_ack(
    token: String,
    sequence: i64,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_FILES_READ,
    )?;
    if sequence < 0 {
        return Err("Acknowledged event sequence must be non-negative.".to_owned());
    }
    let mut session = state
        .stream_session
        .lock()
        .map_err(|_| "Event stream state is unavailable.".to_owned())?;
    let active = session
        .as_mut()
        .ok_or_else(|| "Open an event stream before acknowledging it.".to_owned())?;
    if active.expires_at <= Instant::now() || active.token != token {
        return Err("Event stream token is invalid or expired; open a new session.".to_owned());
    }
    if sequence == active.acknowledged_cursor {
        return Ok(());
    }
    if sequence != active.issued_cursor || sequence < active.acknowledged_cursor {
        return Err(
            "Only the final sequence of the most recently issued page may be acknowledged."
                .to_owned(),
        );
    }
    active.acknowledged_cursor = sequence;
    Ok(())
}

#[tauri::command]
fn agent_stream_close(
    token: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    require_dashboard(&window)?;
    let mut session = state
        .stream_session
        .lock()
        .map_err(|_| "Event stream state is unavailable.".to_owned())?;
    if session.as_ref().is_some_and(|active| active.token == token) {
        *session = None;
    }
    Ok(())
}

#[tauri::command]
fn credential_set(
    provider: String,
    secret: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    miss_minute_agent::secrets::set_provider_secret(&provider, &secret)
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn credential_delete(provider: String, window: tauri::WebviewWindow) -> Result<(), String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    miss_minute_agent::secrets::delete_provider_secret(&provider)
        .map_err(|error| format!("{error:#}"))
}

fn redacted_agent_status(state: &DesktopState) -> AgentStatus {
    AgentStatus {
        enrolled: state.config_path.is_file(),
        running: state.agent_running(),
        roots: Vec::new(),
        events: 0,
        indexed_files: 0,
        decisions: 0,
        last_error: None,
        approved_note_roots: Vec::new(),
        pending_actions: 0,
        auto_create_notes: false,
        foreground_window_context_enabled: false,
        foreground_window_context_supported: cfg!(windows),
        automatic_actions_today: 0,
        daily_note_limit: 3,
    }
}

#[tauri::command]
fn agent_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<AgentStatus, String> {
    require_dashboard(&window)?;
    let authenticated = state
        .owner
        .lock()
        .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?
        .status()
        .authenticated;
    if !authenticated {
        return Ok(redacted_agent_status(&state));
    }
    Ok(agent_status_inner(&state))
}

#[tauri::command]
fn agent_enroll(
    roots: Vec<String>,
    confirm_owner_permission: bool,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    app: tauri::AppHandle,
) -> Result<AgentStatus, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    if !confirm_owner_permission {
        return Err(
            "Review each folder and confirm owner permission before enrollment.".to_owned(),
        );
    }
    if roots.is_empty() {
        return Err("Select at least one directory to authorize.".to_owned());
    }
    if state.config_path.exists() {
        return Err("An enrollment already exists. Use the native agent CLI to change roots after reviewing the current scope.".to_owned());
    }
    let paths = roots.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    create_config(&state.config_path, &paths, true).map_err(|error| format!("{error:#}"))?;
    state.start_agent(app)?;
    Ok(agent_status_inner(&state))
}

#[tauri::command]
fn authorize_note_root(
    path: String,
    confirm_write_permission: bool,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    app: tauri::AppHandle,
) -> Result<AgentStatus, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    grant_note_root(
        &state.config_path,
        Path::new(&path),
        confirm_write_permission,
    )
    .map_err(|error| format!("{error:#}"))?;
    state.stop_agent();
    state.start_agent(app)?;
    Ok(agent_status_inner(&state))
}

#[tauri::command]
fn revoke_note_root(
    path: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    app: tauri::AppHandle,
) -> Result<AgentStatus, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    state.stop_agent();
    let config = drop_note_root(&state.config_path, Path::new(&path))
        .map_err(|error| format!("{error:#}"))?;
    let mut store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    store
        .expire_pending_actions("note_write_permission_revoked")
        .map_err(|error| format!("{error:#}"))?;
    state.start_agent(app)?;
    Ok(agent_status_inner(&state))
}

#[tauri::command]
fn set_auto_note_creation(
    enabled: bool,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    app: tauri::AppHandle,
) -> Result<AgentStatus, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    if enabled {
        // The previous worker is still running with automatic mode disabled.
        configure_auto_note_creation(&state.config_path, true)
            .map_err(|error| format!("{error:#}"))?;
        state.stop_agent();
    } else {
        // Join the worker before disabling so the old in-memory policy cannot
        // execute after this command returns.
        state.stop_agent();
        configure_auto_note_creation(&state.config_path, false)
            .map_err(|error| format!("{error:#}"))?;
    }
    state.start_agent(app)?;
    Ok(agent_status_inner(&state))
}

#[tauri::command]
fn set_foreground_window_context(
    enabled: bool,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    app: tauri::AppHandle,
) -> Result<AgentStatus, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    if enabled && !cfg!(windows) {
        return Err(
            "Foreground window-title context is supported only by the Windows desktop host."
                .to_owned(),
        );
    }

    // Join the current worker before changing consent. The old in-memory
    // policy cannot continue sampling after this command returns.
    state.stop_agent();
    configure_foreground_window_title(&state.config_path, enabled)
        .map_err(|error| format!("{error:#}"))?;
    state.start_agent(app)?;
    Ok(agent_status_inner(&state))
}

#[tauri::command]
fn owner_context_list(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<Vec<miss_minute_agent::store::OwnerContextRecord>, String> {
    require_dashboard(&window)?;
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_MEMORY_READ,
    )?;
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    store.owner_contexts().map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn owner_context_upsert(
    id: Option<String>,
    title: String,
    content: String,
    enabled: bool,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<miss_minute_agent::store::OwnerContextRecord, String> {
    require_dashboard(&window)?;
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_MEMORY_WRITE,
    )?;
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let mut store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    store
        .upsert_owner_context(id.as_deref(), &title, &content, enabled)
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn owner_context_delete(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<bool, String> {
    require_dashboard(&window)?;
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_MEMORY_WRITE,
    )?;
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let mut store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    store
        .delete_owner_context(&id)
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn pending_actions(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<Vec<PendingActionRecord>, String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_FILES_READ,
    )?;
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let mut store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    store
        .pending_actions(50)
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn approve_action(
    action_id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<ActionExecutionResult, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::DEVICE_CONTROL)?;
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let mut store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    approve_and_execute(&config, &mut store, &action_id).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn reject_action(
    action_id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::DEVICE_CONTROL)?;
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let mut store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    store
        .reject_pending_action(&action_id)
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn agent_start(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::DEVICE_CONTROL)?;
    state.start_agent(app)
}

#[tauri::command]
fn agent_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::DEVICE_CONTROL)?;
    state.stop_agent();
    Ok(())
}

#[tauri::command]
fn agent_recent_decisions(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<Vec<serde_json::Value>, String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_FILES_READ,
    )?;
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    let records = store
        .recent_decisions(20)
        .map_err(|error| format!("{error:#}"))?;
    records
        .into_iter()
        .map(|record| {
            serde_json::from_str(&record.decision_json).map_err(|error| error.to_string())
        })
        .collect()
}

#[tauri::command]
fn set_startup(
    enabled: bool,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    manager.is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_startup(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<bool, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_avatar(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<bool, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    let avatar_window = app
        .get_webview_window("avatar")
        .ok_or_else(|| "Avatar window is unavailable".to_owned())?;
    if avatar_window.is_visible().unwrap_or(false) {
        avatar_window.hide().map_err(|error| error.to_string())?;
        Ok(false)
    } else {
        avatar_window.show().map_err(|error| error.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn show_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Dashboard window is unavailable".to_owned())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_avatar_bounds(bounds: AvatarBounds, state: tauri::State<'_, DesktopState>) {
    if let Ok(mut current) = state.avatar_bounds.lock() {
        *current = bounds;
    }
}

#[tauri::command]
fn set_avatar_dragging(dragging: bool, state: tauri::State<'_, DesktopState>) {
    state.avatar_dragging.store(dragging, Ordering::Release);
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AvatarUtterance {
    text: String,
    emotion: String,
    /// Body language to perform while speaking (wave, shrug, point, hips, present, think, knock, clap).
    gesture: Option<String>,
    pitch: f32,
    rate: f32,
    eleven_labs_key: Option<String>,
    eleven_labs_voice_id: Option<String>,
}

/// Only known gesture names reach the avatar window.
fn valid_gesture(gesture: Option<String>) -> Option<String> {
    gesture.filter(|name| {
        matches!(
            name.as_str(),
            "wave" | "shrug" | "point" | "hips" | "present" | "think" | "knock" | "clap"
        )
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn avatar_speak(
    text: String,
    emotion: String,
    gesture: Option<String>,
    pitch: f32,
    rate: f32,
    eleven_labs_key: Option<String>,
    eleven_labs_voice_id: Option<String>,
    style: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    if text.trim().is_empty() || text.len() > 6000 {
        return Err("Avatar speech must contain 1 to 6000 characters.".to_owned());
    }
    let pitch = pitch.clamp(0.5, 2.0);
    let rate = rate.clamp(0.7, 1.5);
    let style = valid_voice_style(style.as_deref());
    let gesture = valid_gesture(gesture);
    state.speak_on_avatar(
        &app,
        AvatarUtterance {
            text,
            emotion,
            gesture,
            pitch,
            rate,
            eleven_labs_key,
            eleven_labs_voice_id,
        },
        style,
    )
}

/// Lets the avatar window speak its click lines through the same router. This is the only
/// speech entry point the overlay gets, it is length-limited, and it cannot reach the agent.
#[tauri::command]
fn avatar_say(
    text: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    if text.trim().is_empty() || text.len() > 240 {
        return Err("Avatar lines must contain 1 to 240 characters.".to_owned());
    }
    state.speak_on_avatar(
        &app,
        AvatarUtterance {
            text,
            emotion: "winking".to_owned(),
            gesture: None,
            pitch: 1.12,
            rate: 1.0,
            eleven_labs_key: None,
            eleven_labs_voice_id: None,
        },
        "conversational",
    )
}

/// Only the four known delivery styles are forwarded to the worker.
fn valid_voice_style(style: Option<&str>) -> &'static str {
    match style {
        Some("narration") => "narration",
        Some("persuasive") => "persuasive",
        Some("informational") => "informational",
        _ => "conversational",
    }
}

#[tauri::command]
fn voice_status(state: tauri::State<'_, DesktopState>) -> VoiceStatus {
    state.voice.status()
}

#[tauri::command]
fn voice_start(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    require_dashboard(&window)?;
    state.voice.start(&app)
}

#[tauri::command]
fn voice_shutdown(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    require_dashboard(&window)?;
    state.prefer_local_voice.store(false, Ordering::Release);
    state.voice.shutdown();
    Ok(())
}

/// Records whether the owner wants the local voice. Enabling it also starts the engine,
/// because loading the models takes tens of seconds and should not delay the first reply.
#[tauri::command]
fn voice_set_preferred(
    enabled: bool,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<VoiceStatus, String> {
    require_dashboard(&window)?;
    state.prefer_local_voice.store(enabled, Ordering::Release);
    if enabled {
        let _ = state.voice.start(&app); // an install problem is reported through status
    }
    Ok(state.voice.status())
}

/// Speaks text in the dashboard window in the local voice. Returns the job id.
///
/// With `stream: true` the text is one sentence of a reply that is still being written: every
/// call with the same `id` adds to one continuous utterance, which `voice_speak_end` closes.
/// Without it, the text is a complete line that replaces whatever she is saying.
#[tauri::command]
fn voice_speak(
    text: String,
    style: Option<String>,
    id: Option<String>,
    stream: Option<bool>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<String, String> {
    require_dashboard(&window)?;
    let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let style = valid_voice_style(style.as_deref());
    if stream == Some(true) {
        state
            .voice
            .speak_stream(&id, &text, style, window.label())?;
    } else {
        state.voice.speak(&id, &text, style, window.label())?;
    }
    Ok(id)
}

/// Ends a streamed utterance started with `voice_speak(stream: true)`.
#[tauri::command]
fn voice_speak_end(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    require_dashboard(&window)?;
    state.voice.speak_end(&id)
}

#[tauri::command]
fn voice_cancel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    require_dashboard(&window)?;
    state.voice.cancel()
}

/// Speech-to-text on this PC (WebView2 has no working Web Speech recognition).
/// `audio` is base64 mono 16-bit little-endian PCM at `sample_rate` Hz.
#[tauri::command]
async fn voice_transcribe(
    audio: String,
    sample_rate: u32,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<String, String> {
    require_dashboard(&window)?;
    state.voice.transcribe(&audio, sample_rate).await
}

pub(crate) fn emergency_kill_switch_inner(
    app: &tauri::AppHandle,
    reason: &str,
) -> Result<owner::OwnerStatus, String> {
    let state = app
        .try_state::<DesktopState>()
        .ok_or_else(|| "Desktop owner authority is unavailable.".to_owned())?;
    state.agent_kill.store(true, Ordering::Release);
    if let Some(provider_state) = app.try_state::<provider::ProviderState>() {
        provider_state.cancel_all();
    }
    clear_unlocked_handles(&state);
    if let Ok(mut wake) = state.wake.lock() {
        wake.reset();
    }
    if let Ok(mut telemetry) = state.telemetry.lock() {
        telemetry.increment("emergency_kills", 1);
    }
    let status = {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        authority.emergency_kill()
    };
    emit_owner_state(app, &status);
    let payload = serde_json::json!({
        "reason": reason,
        "at": util::now_ms(),
    });
    let _ = app.emit_to("main", "miss-minutes:killed", &payload);
    let _ = app.emit_to("avatar", "miss-minutes:killed", &payload);
    desktop_tools::desktop_audit_append(
        app,
        serde_json::json!({
            "event": "emergency_kill",
            "reason": reason,
        }),
    );

    let cleanup_app = app.clone();
    let _ = std::thread::Builder::new()
        .name("miss-minutes-emergency-cleanup".to_owned())
        .spawn(move || {
            if let Some(desktop) = cleanup_app.try_state::<DesktopState>() {
                let _ = desktop.voice.cancel();
                desktop.stop_agent();
                desktop.voice.shutdown();
            }
        });

    Ok(status)
}

#[tauri::command]
fn emergency_kill_switch(
    reason: Option<String>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<owner::OwnerStatus, String> {
    require_dashboard(&window)?;
    let clean_reason = reason
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty() && r.len() <= 128)
        .unwrap_or("owner_ui_kill_switch");
    emergency_kill_switch_inner(&app, clean_reason)
}

#[tauri::command]
fn desktop_audit_verify(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<bool, String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_FILES_READ,
    )?;
    let authority = state
        .owner
        .lock()
        .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
    Ok(authority.verify_audit_chain())
}

#[tauri::command]
fn desktop_audit_entries(
    limit: Option<usize>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<Vec<miss_minute_identity::AuditEntry>, String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_FILES_READ,
    )?;
    let cap = limit.unwrap_or(100).clamp(1, 256);
    let authority = state
        .owner
        .lock()
        .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
    let mut entries = authority.audit_entries();
    if entries.len() > cap {
        entries.drain(0..entries.len() - cap);
    }
    Ok(entries)
}

#[tauri::command]
fn desktop_export_recovery_kit(
    passphrase: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<String, String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::OWNER_PROFILE_MODIFY,
    )?;
    let (result, status) = {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        let res = authority.export_recovery_kit(&window, &passphrase);
        let current = authority.status();
        (res, current)
    };
    if !status.authenticated {
        clear_unlocked_handles(&state);
    } else {
        state.agent_kill.store(false, Ordering::Release);
    }
    emit_owner_state(&app, &status);
    if result.is_ok() {
        desktop_tools::desktop_audit_append(
            &app,
            serde_json::json!({ "event": "recovery_kit_exported" }),
        );
    }
    result
}

#[tauri::command]
fn telemetry_snapshot(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<mm_telemetry::TelemetrySnapshot, String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_FILES_READ,
    )?;
    let telemetry = state
        .telemetry
        .lock()
        .map_err(|_| "Telemetry registry is unavailable.".to_owned())?;
    Ok(telemetry.snapshot())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeFeedResult {
    outcome: mm_wake::WakeOutcome,
    speech_active: bool,
    rms: f32,
    zero_crossing_rate: f32,
    owner_status: owner::OwnerStatus,
}

#[tauri::command]
fn wake_score_feed(
    confidence: f32,
    transcript: Option<String>,
    pcm16_base64: Option<String>,
    custom_phrases: Option<Vec<String>>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<WakeFeedResult, String> {
    require_dashboard(&window)?;
    if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
        return Err("Wake confidence must be a finite number between 0.0 and 1.0.".to_owned());
    }
    if let Some(ref text) = transcript
        && text.len() > 1024
    {
        return Err("Wake transcript exceeds length limit.".to_owned());
    }

    let decoded_pcm = match pcm16_base64 {
        Some(encoded) => {
            if encoded.len() > 1_048_576 {
                return Err("Wake audio chunk exceeds size limit.".to_owned());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded.as_bytes())
                .map_err(|_| "Wake PCM audio is not valid Base64.".to_owned())?;
            if bytes.len() < 4 || !bytes.len().is_multiple_of(2) {
                return Err("Wake PCM audio must contain aligned 16-bit samples.".to_owned());
            }
            let samples: Vec<i16> = bytes
                .chunks_exact(2)
                .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            Some(samples)
        }
        None => None,
    };

    let normalized_custom = custom_phrases.map(|list| {
        list.into_iter()
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty() && p.len() <= 80)
            .take(16)
            .collect::<Vec<_>>()
    });

    let now_ms = state.monotonic_ms();
    let started = Instant::now();
    let (outcome, vad) = {
        let mut wake = state
            .wake
            .lock()
            .map_err(|_| "Wake engine state is unavailable.".to_owned())?;
        if let Some(next_phrases) = normalized_custom
            && next_phrases != wake.config().custom_phrases
        {
            let mut next_cfg = wake.config().clone();
            next_cfg.custom_phrases = next_phrases;
            *wake = mm_wake::WakeEngine::new(next_cfg)
                .map_err(|e| format!("Invalid custom wake phrase configuration: {e}"))?;
        }
        let vad = if let Some(samples) = decoded_pcm.as_deref() {
            mm_wake::evaluate_pcm_vad(samples, &wake.config().vad)
        } else {
            mm_wake::VadDecision {
                speech_active: confidence > 0.0
                    && transcript.as_deref().is_none_or(|t| !t.trim().is_empty()),
                rms: 0.0,
                zero_crossing_rate: 0.0,
            }
        };
        let outcome =
            wake.observe_hit(confidence, transcript.as_deref(), vad.speech_active, now_ms);
        (outcome, vad)
    };
    let elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    if let Ok(mut telemetry) = state.telemetry.lock() {
        telemetry.record_latency_us("wake_eval_us", elapsed_us);
        match &outcome {
            mm_wake::WakeOutcome::Triggered { .. } => telemetry.increment("wake_hits", 1),
            mm_wake::WakeOutcome::Accumulating { .. } => {
                telemetry.increment("wake_accumulating", 1)
            }
            mm_wake::WakeOutcome::EmergencyStop { .. } => {
                telemetry.increment("wake_emergency_stops", 1)
            }
            _ => {}
        }
    }

    let owner_status = match &outcome {
        mm_wake::WakeOutcome::EmergencyStop { phrase } => {
            emergency_kill_switch_inner(&app, &format!("voice_stop:{phrase}"))?
        }
        mm_wake::WakeOutcome::Triggered {
            phrase,
            confidence: hit_conf,
        } => {
            let status = {
                let mut authority = state
                    .owner
                    .lock()
                    .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
                let current = authority.status();
                if current.enrolled && !current.authenticated {
                    let promoted = hit_conf.max(miss_minute_identity::MIN_CANDIDATE_CONFIDENCE);
                    authority.record_candidate_signal("wake", promoted, false, false)?
                } else {
                    current
                }
            };
            emit_owner_state(&app, &status);
            let _ = app.emit_to(
                "main",
                "miss-minutes:wake",
                serde_json::json!({
                    "phrase": phrase,
                    "confidence": hit_conf,
                }),
            );
            status
        }
        _ => {
            let mut authority = state
                .owner
                .lock()
                .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
            authority.status()
        }
    };

    Ok(WakeFeedResult {
        outcome,
        speech_active: vad.speech_active,
        rms: vad.rms,
        zero_crossing_rate: vad.zero_crossing_rate,
        owner_status,
    })
}

#[tauri::command]
fn mission_validate(
    dag: mm_mission::mission::MissionDag,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::DEVICE_CONTROL)?;
    dag.validate().map_err(|e| e.to_string())
}

struct DesktopMissionHandler {
    kill: Arc<AtomicBool>,
}

impl mm_mission::mission::MissionStepHandler for DesktopMissionHandler {
    fn execute_node(&mut self, node: &mm_mission::mission::MissionNode) -> Result<String, String> {
        if self.kill.load(Ordering::Acquire) {
            return Err("emergency kill switch active".to_owned());
        }
        let kind = node.action_kind.trim().to_ascii_lowercase();
        match kind.as_str() {
            "system_info" => desktop_tools::query_system_info().map(|res| res.summary),
            "list_apps" => desktop_tools::query_list_apps(None).map(|res| res.summary),
            "inspect_foreground_ui" => {
                desktop_tools::inspect_foreground_summary().map(|res| res.summary)
            }
            "search" | "gather" | "rank" | "filter" | "synthesize" | "report" | "verify"
            | "checkpoint" | "notify" | "offer_score" | "calendar_scan" | "call_prepare"
            | "read" | "plan" | "write_note" => Ok(format!(
                "verified:{kind}:{}",
                node.title.chars().take(64).collect::<String>()
            )),
            other => Err(format!(
                "Mission action kind \"{other}\" is not permitted on the desktop host."
            )),
        }
    }
}

#[tauri::command]
async fn mission_execute(
    dag: mm_mission::mission::MissionDag,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<mm_mission::mission::MissionRunReport, String> {
    require_dashboard(&window)?;
    if state.agent_kill.load(Ordering::Acquire) {
        return Err(
            "Emergency kill switch is active. Re-authenticate with Windows Hello before executing missions."
                .to_owned(),
        );
    }
    require_owner_capability(&window, miss_minute_identity::capabilities::DEVICE_CONTROL)?;

    // Validate full acyclic structure & bounds BEFORE prompting the user.
    let _order = dag.validate().map_err(|e| e.to_string())?;
    let max_effect = dag
        .nodes
        .iter()
        .map(|n| n.side_effect)
        .max()
        .unwrap_or(mm_mission::tools::SideEffect::ReadOnly);
    let risk = match max_effect {
        mm_mission::tools::SideEffect::ReadOnly | mm_mission::tools::SideEffect::LocalWrite => {
            miss_minute_identity::Risk::Low
        }
        mm_mission::tools::SideEffect::External => miss_minute_identity::Risk::Elevated,
        mm_mission::tools::SideEffect::Destructive => miss_minute_identity::Risk::High,
        mm_mission::tools::SideEffect::Financial => miss_minute_identity::Risk::Critical,
    };

    let requires_dialog = max_effect >= mm_mission::tools::SideEffect::External;
    if requires_dialog {
        let preview_lines = dag
            .nodes
            .iter()
            .take(12)
            .map(|n| {
                format!(
                    "- [{}] {} ({:?})",
                    n.action_kind,
                    n.title.chars().take(60).collect::<String>(),
                    n.side_effect
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let msg = format!(
            "Miss Minutes is requesting permission to run mission \"{}\" ({} steps, peak tier: {:?}).\n\n{}\n\nApprove only if this mission is intended.",
            dag.goal.chars().take(120).collect::<String>(),
            dag.nodes.len(),
            max_effect,
            preview_lines
        );
        if !desktop_tools::show_native_confirmation_dialog(
            &window,
            "Approve Miss Minutes Mission",
            &msg,
        )? {
            desktop_tools::desktop_audit_append(
                &app,
                serde_json::json!({
                    "event": "mission_declined",
                    "missionId": dag.mission_id,
                }),
            );
            return Err("Mission execution was declined by the owner.".to_owned());
        }
    }

    if max_effect >= mm_mission::tools::SideEffect::Destructive {
        let (step_res, current) = {
            let mut authority = state
                .owner
                .lock()
                .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
            let res = authority.require_step_up(&window);
            let status = authority.status();
            (res, status)
        };
        if !current.authenticated {
            clear_unlocked_handles(&state);
        }
        emit_owner_state(&app, &current);
        step_res?;
    }

    if state.agent_kill.load(Ordering::Acquire) {
        return Err("Emergency kill switch halted mission execution.".to_owned());
    }
    {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        authority.authorize_confirmed(
            miss_minute_identity::capabilities::DEVICE_CONTROL,
            risk,
            requires_dialog,
        )?;
    }

    if let Ok(mut telemetry) = state.telemetry.lock() {
        telemetry.set_queue_depth("active_missions", 1);
    }

    let kill_flag = Arc::clone(&state.agent_kill);
    let mission_id = dag.mission_id.clone();
    let started = Instant::now();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut handler = DesktopMissionHandler {
            kill: Arc::clone(&kill_flag),
        };
        mm_mission::mission::execute_mission(&dag, &mut handler, &kill_flag)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|error| format!("Mission task failed: {error}"))?;

    let elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    if let Ok(mut telemetry) = state.telemetry.lock() {
        telemetry.set_queue_depth("active_missions", 0);
        telemetry.record_latency_us("mission_execute_us", elapsed_us);
        telemetry.increment("mission_runs", 1);
    }

    match outcome {
        Ok(report) => {
            desktop_tools::desktop_audit_append(
                &app,
                serde_json::json!({
                    "event": "mission_execute",
                    "missionId": report.mission_id,
                    "runId": report.run_id,
                    "steps": report.checkpoints.len(),
                    "completed": report.completed,
                }),
            );
            Ok(report)
        }
        Err(err) => {
            desktop_tools::desktop_audit_append(
                &app,
                serde_json::json!({
                    "event": "mission_execute",
                    "missionId": mission_id,
                    "completed": false,
                    "error": err,
                }),
            );
            Err(err)
        }
    }
}

#[tauri::command]
fn offers_rank(
    listings: Vec<mm_mission::offers::OfferListing>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<Vec<mm_mission::offers::RankedOffer>, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::HARMLESS_TASK)?;
    if listings.len() > 500 {
        return Err("Offer ranking batch is limited to 500 listings.".to_owned());
    }
    let started = Instant::now();
    let ranked = mm_mission::offers::rank_offers(&listings);
    let elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    if let Ok(mut telemetry) = state.telemetry.lock() {
        telemetry.record_latency_us("offers_rank_us", elapsed_us);
        telemetry.increment("offers_ranked", listings.len() as u64);
    }
    Ok(ranked)
}

#[tauri::command]
fn availability_find(
    busy: Vec<mm_mission::availability::BusyInterval>,
    window_start_min: i64,
    window_end_min: i64,
    min_duration_min: i64,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
) -> Result<mm_mission::availability::AvailabilitySummary, String> {
    require_owner_capability(
        &window,
        miss_minute_identity::capabilities::PRIVATE_MEMORY_READ,
    )?;
    if busy.len() > 2000 {
        return Err("Availability query exceeds 2000 busy intervals.".to_owned());
    }
    let started = Instant::now();
    let summary = mm_mission::availability::find_free_slots(
        &busy,
        window_start_min,
        window_end_min,
        min_duration_min,
    );
    let elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    if let Ok(mut telemetry) = state.telemetry.lock() {
        telemetry.record_latency_us("availability_find_us", elapsed_us);
    }
    Ok(summary)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn calls_prepare(
    destination_e164: String,
    owner_first_name: String,
    facts: Vec<mm_mission::calls::Fact>,
    local_minute_of_day: Option<u16>,
    policy: Option<mm_mission::calls::CallPolicy>,
    dnc_numbers: Option<Vec<String>>,
    calls_placed_today: Option<u32>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<mm_mission::calls::PreparedOutboundCall, String> {
    require_dashboard(&window)?;
    if state.agent_kill.load(Ordering::Acquire) {
        return Err(
            "Emergency kill switch is active. Re-authenticate with Windows Hello before preparing calls."
                .to_owned(),
        );
    }
    require_owner_capability(&window, miss_minute_identity::capabilities::DEVICE_CONTROL)?;

    let local_min = local_minute_of_day.unwrap_or_else(|| {
        use chrono::Timelike;
        let now = chrono::Local::now();
        (now.hour() * 60 + now.minute()) as u16
    });
    let effective_policy = policy.unwrap_or_default();
    let ledger = mm_mission::calls::CallGuardLedger {
        dnc_numbers: dnc_numbers.unwrap_or_default().into_iter().collect(),
        calls_placed_today: calls_placed_today.unwrap_or(0),
    };
    let brand_voice = mm_mission::calls::BrandVoiceProfile::miss_minutes();

    // Validate E.164, DNC, quiet hours, daily cap, and Fact allowlist BEFORE showing any dialog.
    let preview =
        mm_mission::calls::prepare_outbound_call(mm_mission::calls::OutboundCallRequest {
            destination_e164: &destination_e164,
            owner_first_name: &owner_first_name,
            facts: facts.clone(),
            voice: brand_voice.clone(),
            local_minute_of_day: local_min,
            policy: &effective_policy,
            ledger: &ledger,
            owner_confirmed: true,
        })
        .map_err(|e| e.to_string())?;

    let confirm_msg = format!(
        "Miss Minutes is requesting permission to prepare an outbound AI call.\n\nDestination: {}\nBrand Voice: Miss Minutes (TVA Clockwork Assistant)\nAuthorized Facts: {}\nOpening AI Disclosure:\n\"{}\"\n\nApprove only if this outbound call is intended.",
        preview.destination_e164,
        preview.allowed_facts.len(),
        preview.disclosure_opening
    );
    if !desktop_tools::show_native_confirmation_dialog(
        &window,
        "Approve Miss Minutes Outbound Call",
        &confirm_msg,
    )? {
        desktop_tools::desktop_audit_append(
            &app,
            serde_json::json!({ "event": "calls_prepare_declined" }),
        );
        return Err("Outbound call preparation was declined by the owner.".to_owned());
    }

    if state.agent_kill.load(Ordering::Acquire) {
        return Err("Emergency kill switch halted outbound call preparation.".to_owned());
    }
    {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        authority.authorize_confirmed(
            miss_minute_identity::capabilities::DEVICE_CONTROL,
            miss_minute_identity::Risk::Elevated,
            true,
        )?;
    }

    let started = Instant::now();
    let prepared =
        mm_mission::calls::prepare_outbound_call(mm_mission::calls::OutboundCallRequest {
            destination_e164: &destination_e164,
            owner_first_name: &owner_first_name,
            facts,
            voice: brand_voice,
            local_minute_of_day: local_min,
            policy: &effective_policy,
            ledger: &ledger,
            owner_confirmed: true,
        })
        .map_err(|e| e.to_string())?;
    let elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    if let Ok(mut telemetry) = state.telemetry.lock() {
        telemetry.record_latency_us("calls_prepare_us", elapsed_us);
        telemetry.increment("calls_prepared", 1);
    }
    desktop_tools::desktop_audit_append(
        &app,
        serde_json::json!({
            "event": "calls_prepare",
            "callId": prepared.call_id,
            "voice": prepared.voice.voice_id(),
            "factCount": prepared.allowed_facts.len(),
        }),
    );
    Ok(prepared)
}

#[tauri::command]
fn mcp_import_tool(
    server_name: String,
    tool_json: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<mm_mission::tools::ToolManifest, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    if server_name.len() > 128 || tool_json.len() > 64 * 1024 {
        return Err("MCP tool manifest exceeds size limits.".to_owned());
    }
    let manifest =
        mm_mission::tools::import_mcp_tool(&server_name, &tool_json).map_err(|e| e.to_string())?;
    desktop_tools::desktop_audit_append(
        &app,
        serde_json::json!({
            "event": "mcp_import_tool",
            "id": manifest.id,
            "derivedSideEffect": manifest.derived_side_effect,
        }),
    );
    Ok(manifest)
}

#[tauri::command]
fn mcp_reclassify_tool(
    mut manifest: mm_mission::tools::ToolManifest,
    requested: mm_mission::tools::SideEffect,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<mm_mission::tools::ToolManifest, String> {
    require_owner_capability(&window, miss_minute_identity::capabilities::SETTINGS_MODIFY)?;
    if matches!(
        manifest.derived_side_effect,
        mm_mission::tools::SideEffect::Financial
    ) && requested < mm_mission::tools::SideEffect::Financial
    {
        return Err("Financial MCP tools cannot be downgraded to a lower risk tier.".to_owned());
    }

    let confirm_msg = format!(
        "Miss Minutes is requesting permission to reclassify an untrusted MCP connector tool.\n\nTool: {}\nCurrent derived tier: {:?}\nRequested tier: {:?}\n\nApprove only if you have audited this tool.",
        manifest.id, manifest.derived_side_effect, requested
    );
    if !desktop_tools::show_native_confirmation_dialog(
        &window,
        "Approve MCP Tool Reclassification",
        &confirm_msg,
    )? {
        desktop_tools::desktop_audit_append(
            &app,
            serde_json::json!({
                "event": "mcp_reclassify_declined",
                "id": manifest.id,
            }),
        );
        return Err("MCP tool reclassification was declined by the owner.".to_owned());
    }

    {
        let mut authority = state
            .owner
            .lock()
            .map_err(|_| "Desktop owner authority is unavailable.".to_owned())?;
        authority.authorize_confirmed(
            miss_minute_identity::capabilities::SETTINGS_MODIFY,
            miss_minute_identity::Risk::Elevated,
            true,
        )?;
    }

    mm_mission::tools::reclassify_mcp_tool(&mut manifest, requested, true)
        .map_err(|e| e.to_string())?;
    desktop_tools::desktop_audit_append(
        &app,
        serde_json::json!({
            "event": "mcp_reclassify_tool",
            "id": manifest.id,
            "derivedSideEffect": manifest.derived_side_effect,
        }),
    );
    Ok(manifest)
}

fn make_tray_icon() -> tauri::image::Image<'static> {
    let mut pixels = vec![0_u8; 32 * 32 * 4];
    for y in 0..32_i32 {
        for x in 0..32_i32 {
            let dx = x - 16;
            let dy = y - 16;
            if dx * dx + dy * dy <= 14 * 14 {
                let index = ((y as usize * 32) + x as usize) * 4;
                pixels[index] = 245;
                pixels[index + 1] = 129;
                pixels[index + 2] = 36;
                pixels[index + 3] = 255;
            }
            if ((x == 15 || x == 16) && (8..18).contains(&y))
                || ((y == 18 || y == 19) && (15..24).contains(&x))
            {
                let index = ((y as usize * 32) + x as usize) * 4;
                pixels[index..index + 4].copy_from_slice(&[255, 248, 220, 255]);
            }
        }
    }
    tauri::image::Image::new_owned(pixels, 32, 32)
}

fn create_avatar_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("avatar").is_some() {
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        "avatar",
        WebviewUrl::App("index.html?overlay=1".into()),
    )
    .title("Miss Minutes Companion")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .shadow(false)
    .focused(false)
    .visible(true);

    // The click-through overlay rarely receives a user gesture, and WebView2 otherwise keeps
    // audio suspended until it does. Setting browser args replaces wry's defaults, so they are
    // repeated here.
    #[cfg(target_os = "windows")]
    {
        builder = builder.additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --autoplay-policy=no-user-gesture-required",
        );
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(monitor) = app.primary_monitor()? {
            let scale = monitor.scale_factor();
            let position = monitor.position();
            let size = monitor.size();
            builder = builder
                .position(position.x as f64 / scale, position.y as f64 / scale)
                .inner_size(size.width as f64 / scale, size.height as f64 / scale);
        } else {
            builder = builder.fullscreen(true);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        builder = builder.inner_size(390.0, 430.0).position(32.0, 72.0);
    }

    let window = builder.build()?;
    #[cfg(target_os = "windows")]
    window.set_ignore_cursor_events(true)?;

    #[cfg(not(target_os = "windows"))]
    window.set_ignore_cursor_events(false)?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn start_windows_cursor_gate(
    app: tauri::AppHandle,
    bounds: Arc<Mutex<AvatarBounds>>,
    dragging: Arc<AtomicBool>,
) {
    use windows::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};

    std::thread::Builder::new()
        .name("miss-minutes-hit-test".to_owned())
        .spawn(move || {
            let mut last_ignore = true;
            loop {
                let Some(window) = app.get_webview_window("avatar") else {
                    break;
                };
                let bounds = bounds
                    .lock()
                    .ok()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                let scale = window.scale_factor().unwrap_or(1.0);
                let origin = window.outer_position().ok();
                let mut cursor = POINT::default();
                let cursor_available = unsafe { GetCursorPos(&mut cursor).is_ok() };

                let interactive = dragging.load(Ordering::Acquire)
                    || if let Some(origin) = origin.filter(|_| cursor_available) {
                        let left = origin.x as f64 + (bounds.x - 12.0) * scale;
                        let top = origin.y as f64 + (bounds.y - 12.0) * scale;
                        let right = origin.x as f64 + (bounds.x + bounds.width + 12.0) * scale;
                        let bottom = origin.y as f64 + (bounds.y + bounds.height + 20.0) * scale;
                        (cursor.x as f64) >= left
                            && (cursor.x as f64) <= right
                            && (cursor.y as f64) >= top
                            && (cursor.y as f64) <= bottom
                    } else {
                        false
                    };

                let ignore = !interactive;
                if ignore != last_ignore {
                    let _ = window.set_ignore_cursor_events(ignore);
                    last_ignore = ignore;
                }
                std::thread::sleep(Duration::from_millis(35));
            }
        })
        .ok();
}

#[cfg(target_os = "windows")]
fn start_windows_session_lock_watcher(app: tauri::AppHandle) {
    use std::sync::OnceLock;
    use windows::{
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, WPARAM},
            System::RemoteDesktop::{
                NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification,
                WTSUnRegisterSessionNotification,
            },
            UI::{
                Input::KeyboardAndMouse::{
                    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, RegisterHotKey, UnregisterHotKey, VK_BACK,
                },
                WindowsAndMessaging::{
                    CS_OWNDC, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW,
                    HWND_MESSAGE, MSG, PBT_APMSUSPEND, RegisterClassW, TranslateMessage,
                    WINDOW_EX_STYLE, WINDOW_STYLE, WM_DESTROY, WM_HOTKEY, WM_POWERBROADCAST,
                    WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK,
                    WTS_SESSION_LOGOFF,
                },
            },
        },
        core::w,
    };

    const KILL_HOTKEY_ID: i32 = 0x4D4D;

    static SESSION_WATCH_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    let _ = SESSION_WATCH_APP.set(app);

    unsafe extern "system" fn session_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        _lparam: LPARAM,
    ) -> LRESULT {
        let mut kill_requested = false;
        let should_lock = match msg {
            WM_HOTKEY if wparam.0 as i32 == KILL_HOTKEY_ID => {
                kill_requested = true;
                false
            }
            WM_WTSSESSION_CHANGE => {
                let event = wparam.0 as u32;
                event == WTS_SESSION_LOCK
                    || event == WTS_SESSION_LOGOFF
                    || event == WTS_REMOTE_DISCONNECT
            }
            WM_POWERBROADCAST => wparam.0 as u32 == PBT_APMSUSPEND,
            WM_DESTROY => {
                let _ = unsafe { UnregisterHotKey(Some(hwnd), KILL_HOTKEY_ID) };
                let _ = unsafe { WTSUnRegisterSessionNotification(hwnd) };
                false
            }
            _ => false,
        };
        if kill_requested {
            if let Some(app) = SESSION_WATCH_APP.get() {
                let _ = emergency_kill_switch_inner(app, "hotkey_ctrl_alt_backspace");
            }
        } else if should_lock && let Some(app) = SESSION_WATCH_APP.get() {
            lock_and_clear_owner_state(app);
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, _lparam) }
    }

    let _ = std::thread::Builder::new()
        .name("miss-minutes-session-watch".to_owned())
        .spawn(move || {
            let class_name = w!("MissMinutesSessionWatch");
            let wc = WNDCLASSW {
                style: CS_OWNDC,
                lpfnWndProc: Some(session_wnd_proc),
                lpszClassName: class_name,
                ..Default::default()
            };
            let atom = unsafe { RegisterClassW(&wc) };
            if atom == 0 {
                eprintln!("[desktop] Failed to register Windows session lock watcher class.");
                return;
            }
            let hwnd = match unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    class_name,
                    w!("MissMinutesSessionWatch"),
                    WINDOW_STYLE(0),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    None,
                    None,
                )
            } {
                Ok(hwnd) => hwnd,
                Err(error) => {
                    eprintln!("[desktop] Failed to create Windows session watcher window: {error}");
                    return;
                }
            };
            if let Err(error) =
                unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) }
            {
                eprintln!(
                    "[desktop] Failed to subscribe to WTS session lock notifications: {error}"
                );
                return;
            }
            if let Err(error) = unsafe {
                RegisterHotKey(
                    Some(hwnd),
                    KILL_HOTKEY_ID,
                    MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                    u32::from(VK_BACK.0),
                )
            } {
                eprintln!("[desktop] Failed to register Ctrl+Alt+Backspace kill hotkey: {error}");
            }
            let mut msg = MSG::default();
            while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
                let _ = unsafe { TranslateMessage(&msg) };
                unsafe { DispatchMessageW(&msg) };
            }
        });
}

/// Quits Miss Minutes: the dashboard, the overlay and the tray icon all go away.
///
/// Destroying the windows, rather than exiting at once, closes each WebView2 cleanly. Tauri
/// ends the app when the last window is gone, and the `RunEvent::Exit` handler then stops the
/// agent and the voice worker.
fn quit_app(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(0);
        return;
    }
    for window in windows.values() {
        let _ = window.destroy();
    }
}

fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
    let avatar = MenuItem::with_id(app, "avatar", "Show / hide avatar", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Stop local agent", true, None::<&str>)?;
    let kill = MenuItem::with_id(
        app,
        "kill",
        "Emergency Stop & Lock (Ctrl+Alt+Backspace)",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Miss Minutes", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &avatar, &pause, &kill, &quit])?;

    let tray = TrayIconBuilder::new()
        .icon(make_tray_icon())
        .tooltip("Miss Minutes")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "avatar" => {
                if let Some(window) = app.get_webview_window("avatar") {
                    let visible = window.is_visible().unwrap_or(false);
                    if visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                    }
                }
            }
            "pause" => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    state.stop_agent();
                }
            }
            "kill" => {
                let _ = emergency_kill_switch_inner(app, "tray_emergency_stop");
            }
            "quit" => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    state.stop_agent();
                }
                quit_app(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
                && let Some(window) = tray.app_handle().get_webview_window("main")
            {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        })
        .build(app)?;

    app.manage(tray);
    Ok(())
}

pub fn run() {
    // Create the job that the app's helper processes join as they spawn, so they end with the
    // app even after a crash or a Task Manager kill. The app's own process stays out of it, so
    // programs opened for the user are never caught by it.
    if let Err(error) = job::init() {
        eprintln!("[desktop] Helper processes are not tied to the app's lifetime: {error}");
    }

    let autostart_builder = tauri_plugin_autostart::Builder::new()
        .app_name("Miss Minutes")
        .args(["--background"]);
    #[cfg(target_os = "macos")]
    let autostart_builder = autostart_builder.macos_launcher(MacosLauncher::LaunchAgent);

    let builder = tauri::Builder::default()
        // Registered first, so a second launch is caught before anything else starts. That
        // launch exits without creating a window, and this callback runs in the running app.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Login autostart never pops the dashboard over an instance that already runs.
            if args.iter().any(|argument| argument == "--background") {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(autostart_builder.build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let state = DesktopState::new(
                app_data.join("miss-minute-agent.json"),
                app_data.join("owner"),
            )
            .map_err(std::io::Error::other)?;
            let bounds = Arc::clone(&state.avatar_bounds);
            let dragging = Arc::clone(&state.avatar_dragging);
            app.manage(state);
            // Register per-module states so their Tauri commands can resolve
            // `tauri::State<'_, T>` at runtime (panics if missing).
            app.manage(provider::ProviderState::default());
            app.manage(openrouter::OpenRouterState::default());

            create_avatar_window(app.handle())?;
            create_tray(app)?;
            scheduler::start(app.handle().clone());

            // Rehydrate the enrolled native worker on normal app launch and
            // login startup. A missing or invalid config never blocks the UI.
            if let Some(state) = app.try_state::<DesktopState>()
                && state.config_path.is_file()
                && let Err(error) = state.start_agent(app.handle().clone())
            {
                eprintln!("[desktop] The saved agent could not be restarted: {error}");
            }

            #[cfg(target_os = "windows")]
            {
                start_windows_cursor_gate(app.handle().clone(), bounds, dragging);
                start_windows_session_lock_watcher(app.handle().clone());
            }

            #[cfg(not(target_os = "windows"))]
            let _ = (bounds, dragging);

            if std::env::args().any(|argument| argument == "--background")
                && let Some(main) = app.get_webview_window("main")
            {
                let _ = main.hide();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_status,
            owner_status,
            owner_enroll,
            owner_authenticate,
            owner_lock,
            owner_candidate_signal,
            owner_step_up_authenticate,
            owner_mode_get,
            owner_data::owner_data,
            owner_pair_android,
            owner_recover_android_kit,
            credential_set,
            credential_delete,
            agent_stream_open,
            agent_events_after,
            agent_stream_ack,
            agent_stream_close,
            agent_enroll,
            agent_start,
            agent_stop,
            agent_recent_decisions,
            authorize_note_root,
            revoke_note_root,
            set_auto_note_creation,
            set_foreground_window_context,
            owner_context_list,
            owner_context_upsert,
            owner_context_delete,
            pending_actions,
            approve_action,
            reject_action,
            set_startup,
            get_startup,
            toggle_avatar,
            show_dashboard,
            set_avatar_bounds,
            set_avatar_dragging,
            avatar_speak,
            avatar_say,
            voice_status,
            voice_start,
            voice_shutdown,
            voice_set_preferred,
            voice_speak,
            voice_speak_end,
            voice_cancel,
            voice_transcribe,
            provider::provider_http_stream,
            provider::provider_http_cancel,
            provider::provider_has_credential,
            provider::realtime_client_secret,
            chatgpt::chatgpt_sign_in,
            chatgpt::chatgpt_account,
            chatgpt::chatgpt_sign_out,
            chatgpt::chatgpt_models,
            openrouter::openrouter_pair_start,
            openrouter::openrouter_pair_complete,
            desktop_tools::desktop_propose,
            desktop_tools::desktop_run,
            desktop_tools::desktop_approve,
            desktop_tools::desktop_reject,
            desktop_tools::desktop_audit,
            desktop_tools::desktop_agent_run,
            desktop_tools::capture_screen,
            scheduler::schedule_sync,
            emergency_kill_switch,
            desktop_audit_verify,
            desktop_audit_entries,
            desktop_export_recovery_kit,
            telemetry_snapshot,
            wake_score_feed,
            mission_validate,
            mission_execute,
            offers_rank,
            availability_find,
            calls_prepare,
            mcp_import_tool,
            mcp_reclassify_tool
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // Closing the dashboard quits the app; she never stays behind on screen.
                    quit_app(window.app_handle());
                } else {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!());

    let app = match builder {
        Ok(app) => app,
        Err(error) => {
            eprintln!("[desktop] Failed to build Miss Minutes desktop host: {error}");
            return;
        }
    };

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Stop her own helpers cleanly first. The voice worker is asked to exit and joined;
            // anything still in the job (such as a running command) ends when the process exits
            // and the job's last handle closes.
            if let Some(state) = handle.try_state::<DesktopState>() {
                state.stop_agent();
                state.voice.shutdown();
            }
        }
    });
}
