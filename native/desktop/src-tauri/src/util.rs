//! Host-side utilities shared by the provider proxy, OAuth sign-ins, desktop tools and
//! scheduler: app-data paths, atomic file writes, opening the system browser and building
//! HTTP clients with the connect/idle budgets the proxy enforces.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

/// Milliseconds since the Unix epoch, saturating at 0 before 1970.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

/// The per-user app data directory, created if missing. Everything the host persists
/// (tokens, audit log, scheduled alerts) lives here.
pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("The app data directory is unavailable: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("Cannot create the app data directory: {error}"))?;
    Ok(dir)
}

/// Writes `bytes` to `path` as atomically as the platform allows: write a sibling temp file,
/// flush it, then rename it into place. Parent directories are created first.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    }
    let mut temp = path.as_os_str().to_os_string();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, bytes).map_err(|error| format!("Cannot write {}: {error}", temp.display()))?;
    // Windows `rename` refuses to replace an existing file, so clear it first. The window
    // between remove and rename is acceptable for single-app local state.
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&temp, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Cannot finalize {}: {error}", path.display())
    })
}

/// Opens `url` (or a file path) with the user's default handler. Used for the OAuth system
/// browser hand-off. The caller is responsible for not logging URLs that carry hints.
#[cfg(windows)]
pub fn open_in_browser(target: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation = HSTRING::from("open");
    let file = HSTRING::from(target);
    // SAFETY: both wide strings outlive the call; all other arguments are null/!defaults.
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW returns a pseudo-HINSTANCE; values <= 32 signal failure.
    if (result.0 as usize) <= 32 {
        return Err("Could not open the system browser.".to_owned());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn open_in_browser(target: &str) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the system browser: {error}"))
}

/// `application/x-www-form-urlencoded` body for OAuth token/revocation requests. Using the
/// `url` crate avoids pulling reqwest's optional `form` feature.
pub fn form_encode(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs.iter().copied())
        .finish()
}

/// Builds an HTTP client with a bounded connect timeout. The per-chunk idle timeout is
/// enforced by the caller around each read, so no overall request timeout is set here.
/// `allow_proxy` is false for loopback (Ollama) requests so a configured system proxy is
/// never consulted for localhost.
pub fn http_client(connect_timeout: Duration, allow_proxy: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .user_agent("MissMinutes-Desktop/0.1")
        .use_rustls_tls();
    if !allow_proxy {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|error| format!("Cannot create the HTTP client: {error}"))
}
