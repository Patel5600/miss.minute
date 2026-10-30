use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::Duration,
};

use miss_minute_agent::{
    collector::run_agent_until,
    config::{create_config, load_config},
    store::Store,
};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};

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
    agent: Mutex<Option<AgentRuntime>>,
    avatar_bounds: Arc<Mutex<AvatarBounds>>,
}

impl DesktopState {
    fn new(config_path: PathBuf) -> Self {
        Self {
            config_path,
            agent: Mutex::new(None),
            avatar_bounds: Arc::new(Mutex::new(AvatarBounds::default())),
        }
    }

    fn stop_agent(&self) {
        if let Ok(mut slot) = self.agent.lock() {
            if let Some(mut runtime) = slot.take() {
                runtime.shutdown.store(true, Ordering::Release);
                if let Some(join) = runtime.join.take() {
                    let _ = join.join();
                }
            }
        }
    }

    fn start_agent(&self) -> Result<(), String> {
        let config = load_config(&self.config_path).map_err(|error| format!("{error:#}"))?;
        let mut slot = self.agent.lock().map_err(|_| "Agent state is unavailable".to_owned())?;

        if let Some(runtime) = slot.as_ref() {
            if runtime.join.as_ref().is_some_and(|join| !join.is_finished()) {
                return Ok(());
            }
        }
        if let Some(mut previous) = slot.take() {
            if let Some(join) = previous.join.take() {
                let _ = join.join();
            }
        }

        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = Arc::clone(&shutdown);
        let last_error = Arc::new(Mutex::new(None));
        let worker_error = Arc::clone(&last_error);

        let join = std::thread::Builder::new()
            .name("miss-minutes-agent".to_owned())
            .spawn(move || {
                if let Err(error) = run_agent_until(&config, 45, 300, worker_shutdown) {
                    if let Ok(mut slot) = worker_error.lock() {
                        *slot = Some(format!("{error:#}"));
                    }
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
            .and_then(|slot| slot.as_ref().map(|runtime| {
                runtime.join.as_ref().is_some_and(|join| !join.is_finished())
            }))
            .unwrap_or(false)
    }
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
    };

    if let Ok(slot) = state.agent.lock() {
        if let Some(runtime) = slot.as_ref() {
            status.last_error = runtime.last_error.lock().ok().and_then(|value| value.clone());
        }
    }

    if let Ok(config) = load_config(&state.config_path) {
        status.roots = config.consent.allowed_roots
            .iter()
            .map(|root| root.display().to_string())
            .collect();

        if let Ok(store) = Store::open(&config.database_path) {
            if let Ok((events, files, decisions)) = store.counts() {
                status.events = events;
                status.indexed_files = files;
                status.decisions = decisions;
            }
        }
    }
    status
}

#[tauri::command]
fn agent_status(state: tauri::State<'_, DesktopState>) -> AgentStatus {
    agent_status_inner(&state)
}

#[tauri::command]
fn agent_enroll(
    roots: Vec<String>,
    confirm_owner_permission: bool,
    state: tauri::State<'_, DesktopState>,
) -> Result<AgentStatus, String> {
    if !confirm_owner_permission {
        return Err("Review each folder and confirm owner permission before enrollment.".to_owned());
    }
    if roots.is_empty() {
        return Err("Select at least one directory to authorize.".to_owned());
    }
    if state.config_path.exists() {
        return Err("An enrollment already exists. Use the native agent CLI to change roots after reviewing the current scope.".to_owned());
    }
    let paths = roots.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    create_config(&state.config_path, &paths, true)
        .map_err(|error| format!("{error:#}"))?;
    state.start_agent()?;
    Ok(agent_status_inner(&state))
}

#[tauri::command]
fn agent_start(state: tauri::State<'_, DesktopState>) -> Result<(), String> {
    state.start_agent()
}

#[tauri::command]
fn agent_stop(state: tauri::State<'_, DesktopState>) {
    state.stop_agent();
}

#[tauri::command]
fn agent_recent_decisions(
    state: tauri::State<'_, DesktopState>,
) -> Result<Vec<serde_json::Value>, String> {
    let config = load_config(&state.config_path).map_err(|error| format!("{error:#}"))?;
    let store = Store::open(&config.database_path).map_err(|error| format!("{error:#}"))?;
    let records = store.recent_decisions(20).map_err(|error| format!("{error:#}"))?;
    records
        .into_iter()
        .map(|record| serde_json::from_str(&record.decision_json).map_err(|error| error.to_string()))
        .collect()
}

#[tauri::command]
fn set_startup(enabled: bool, app: tauri::AppHandle) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    manager.is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_startup(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_avatar(app: tauri::AppHandle) -> Result<bool, String> {
    let window = app.get_webview_window("avatar")
        .ok_or_else(|| "Avatar window is unavailable".to_owned())?;
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|error| error.to_string())?;
        Ok(false)
    } else {
        window.show().map_err(|error| error.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn show_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main")
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

    #[cfg(target_os = "windows")]
    {
        if let Some(monitor) = app.primary_monitor()? {
            let scale = monitor.scale_factor();
            let position = monitor.position();
            let size = monitor.size();
            builder = builder
                .position(tauri::LogicalPosition::new(
                    position.x as f64 / scale,
                    position.y as f64 / scale,
                ))
                .inner_size(
                    size.width as f64 / scale,
                    size.height as f64 / scale,
                );
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
fn start_windows_cursor_gate(app: tauri::AppHandle, bounds: Arc<Mutex<AvatarBounds>>) {
    use windows::Win32::{
        Foundation::POINT,
        UI::WindowsAndMessaging::GetCursorPos,
    };

    std::thread::Builder::new()
        .name("miss-minutes-hit-test".to_owned())
        .spawn(move || {
            let mut last_ignore = true;
            loop {
                let Some(window) = app.get_webview_window("avatar") else {
                    break;
                };
                let bounds = bounds.lock().ok().map(|value| value.clone()).unwrap_or_default();
                let scale = window.scale_factor().unwrap_or(1.0);
                let origin = window.outer_position().ok();
                let mut cursor = POINT::default();
                let cursor_available = unsafe { GetCursorPos(&mut cursor).is_ok() };

                let interactive = if let Some(origin) = origin.filter(|_| cursor_available) {
                    let left = origin.x as f64 + (bounds.x - 12.0) * scale;
                    let top = origin.y as f64 + (bounds.y - 110.0) * scale;
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

fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
    let avatar = MenuItem::with_id(app, "avatar", "Show / hide avatar", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Stop local agent", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Miss Minutes", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &avatar, &pause, &quit])?;

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
                    if visible { let _ = window.hide(); } else { let _ = window.show(); }
                }
            }
            "pause" => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    state.stop_agent();
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<DesktopState>() {
                    state.stop_agent();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    app.manage(tray);
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Miss Minutes")
                .args(["--background"])
                .macos_launcher(MacosLauncher::LaunchAgent)
                .build(),
        )
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let state = DesktopState::new(app_data.join("miss-minute-agent.json"));
            let bounds = Arc::clone(&state.avatar_bounds);
            app.manage(state);

            create_avatar_window(app.handle())?;
            create_tray(app)?;

            #[cfg(target_os = "windows")]
            start_windows_cursor_gate(app.handle().clone(), bounds);

            #[cfg(not(target_os = "windows"))]
            let _ = bounds;

            if std::env::args().any(|argument| argument == "--background") {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_status,
            agent_enroll,
            agent_start,
            agent_stop,
            agent_recent_decisions,
            set_startup,
            get_startup,
            toggle_avatar,
            show_dashboard,
            set_avatar_bounds
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Miss Minutes desktop host");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<DesktopState>() {
                state.stop_agent();
            }
        }
    });
}
