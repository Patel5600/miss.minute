//! Native AI provider proxy: the WebView asks for a provider request, the host injects the
//! credential from the OS vault (or the ChatGPT OAuth session) and streams the response back
//! over a Tauri Channel. API keys and tokens never enter the renderer, and the renderer can
//! never reach a host other than the one allow-listed for the chosen provider.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::sync::Notify;
use url::Url;

use crate::util;

const MAX_BODY_BYTES: usize = 20 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHttpRequest {
    /// Which stored credential to inject: openai | gemini | anthropic | openrouter | chatgpt | ollama | elevenlabs
    pub provider: String,
    pub url: String,
    pub method: Option<String>,
    /// Non-secret headers only. Authorization-like headers are rejected.
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    /// "text" (default) or "bytes" (base64 chunks, for audio).
    pub response_type: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ProviderStreamEvent {
    Head { status: u16, headers: HashMap<String, String> },
    Data { text: String },
    Bytes { base64: String },
    End,
    Error { message: String },
}

/// Tracks in-flight streams so `provider_http_cancel` can abort one by request id.
#[derive(Default)]
pub struct ProviderState {
    inflight: Mutex<HashMap<String, (Arc<Notify>, Arc<AtomicBool>)>>,
}

impl ProviderState {
    fn register(&self, id: &str, notify: Arc<Notify>, flag: Arc<AtomicBool>) {
        if let Ok(mut map) = self.inflight.lock() {
            map.insert(id.to_owned(), (notify, flag));
        }
    }

    fn unregister(&self, id: &str) {
        if let Ok(mut map) = self.inflight.lock() {
            map.remove(id);
        }
    }

    fn cancel(&self, id: &str) {
        if let Ok(map) = self.inflight.lock() {
            if let Some((notify, flag)) = map.get(id) {
                flag.store(true, Ordering::Release);
                notify.notify_waiters();
            }
        }
    }
}

/// Streams a provider HTTP response. Resolves after the final `End` or `Error` event.
#[tauri::command]
pub async fn provider_http_stream(
    request: ProviderHttpRequest,
    request_id: String,
    on_event: Channel<ProviderStreamEvent>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, ProviderState>,
) -> Result<(), String> {
    crate::require_dashboard(&window)?;

    let notify = Arc::new(Notify::new());
    let flag = Arc::new(AtomicBool::new(false));
    state.register(&request_id, notify.clone(), flag.clone());

    let result = run_stream(&request, &app, &on_event, &notify, &flag).await;
    state.unregister(&request_id);

    match result {
        Ok(()) => Ok(()),
        Err(message) => {
            // Surface the failure on the channel too, so the renderer sees it even if it
            // ignores the promise rejection.
            let _ = on_event.send(ProviderStreamEvent::Error { message: message.clone() });
            Err(message)
        }
    }
}

#[tauri::command]
pub fn provider_http_cancel(
    request_id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ProviderState>,
) -> Result<(), String> {
    crate::require_dashboard(&window)?;
    state.cancel(&request_id);
    Ok(())
}

/// True when a credential for `provider` is stored (or none is required). Never returns the secret.
#[tauri::command]
pub fn provider_has_credential(
    provider: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    crate::require_dashboard(&window)?;
    match provider.as_str() {
        // Ollama is a local server: no credential is needed, so treat it as always available.
        "ollama" => Ok(true),
        "chatgpt" => Ok(crate::chatgpt::is_signed_in(&app)),
        "openai" | "gemini" | "anthropic" | "openrouter" | "elevenlabs" => {
            Ok(miss_minute_agent::secrets::get_provider_secret(&provider)
                .map_err(|error| format!("{error:#}"))?
                .is_some())
        }
        _ => Err("Unknown provider.".to_owned()),
    }
}

/// Mints a short-lived realtime secret for client-side live voice. The long-lived key never
/// leaves the host; only the ephemeral token payload is returned.
#[tauri::command]
pub async fn realtime_client_secret(
    provider: String,
    session: serde_json::Value,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    crate::require_dashboard(&window)?;
    match provider.as_str() {
        "openai" => {
            let key = stored_secret("openai")?;
            let client = util::http_client(CONNECT_TIMEOUT, true)?;
            let response = client
                .post("https://api.openai.com/v1/realtime/client_secrets")
                .bearer_auth(key)
                .json(&serde_json::json!({ "session": session }))
                .send()
                .await
                .map_err(describe_error)?;
            read_json_or_error(response).await
        }
        "gemini" => {
            let key = stored_secret("gemini")?;
            let client = util::http_client(CONNECT_TIMEOUT, true)?;
            let response = client
                .post("https://generativelanguage.googleapis.com/v1beta/auth_tokens")
                .header("x-goog-api-key", key)
                .json(&gemini_token_body(session))
                .send()
                .await
                .map_err(describe_error)?;
            read_json_or_error(response).await
        }
        _ => Err("Realtime secrets are available for the openai and gemini providers only.".to_owned()),
    }
}

/// Builds the ephemeral-token request body for Gemini Live, filling sane short-lived defaults
/// when the renderer does not specify them.
fn gemini_token_body(session: Value) -> Value {
    let mut body = match session {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        other => {
            // A non-object session is treated as live-connect constraints.
            let mut map = serde_json::Map::new();
            map.insert("liveConnectConstraints".to_owned(), other);
            map
        }
    };
    body.entry("uses").or_insert(Value::from(1));
    let now = chrono::Utc::now();
    body.entry("expireTime").or_insert(Value::from(
        (now + chrono::Duration::minutes(30)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    ));
    body.entry("newSessionExpireTime").or_insert(Value::from(
        (now + chrono::Duration::minutes(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    ));
    Value::Object(body)
}

async fn run_stream(
    request: &ProviderHttpRequest,
    app: &tauri::AppHandle,
    on_event: &Channel<ProviderStreamEvent>,
    cancel: &Notify,
    flag: &AtomicBool,
) -> Result<(), String> {
    let provider = request.provider.as_str();
    let url = Url::parse(&request.url).map_err(|_| "The request URL is not valid.".to_owned())?;
    validate_target(provider, &url)?;

    let method = match request.method.as_deref() {
        Some(value) if value.eq_ignore_ascii_case("GET") => Method::GET,
        Some(value) if value.eq_ignore_ascii_case("POST") => Method::POST,
        Some(other) => return Err(format!("The {other} method is not allowed.")),
        None => {
            if request.body.is_some() {
                Method::POST
            } else {
                Method::GET
            }
        }
    };

    if let Some(body) = &request.body {
        if body.len() > MAX_BODY_BYTES {
            return Err("The request body exceeds the 20 MB limit.".to_owned());
        }
    }

    let mut headers = sanitize_headers(request.headers.as_ref())?;
    inject_credential(provider, &mut headers, app).await?;

    let client = util::http_client(CONNECT_TIMEOUT, provider != "ollama")?;
    let mut builder = client.request(method, url).headers(headers);
    if let Some(body) = request.body.clone() {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(describe_error)?;
    let status = response.status().as_u16();
    let safe_headers = safe_response_headers(response.headers());
    send_event(on_event, ProviderStreamEvent::Head { status, headers: safe_headers })?;

    let bytes_mode = matches!(request.response_type.as_deref(), Some("bytes"));
    let mut response = response;
    let mut carry: Vec<u8> = Vec::new();

    loop {
        if flag.load(Ordering::Acquire) {
            return cancelled(on_event);
        }
        let next = tokio::select! {
            _ = cancel.notified() => return cancelled(on_event),
            read = tokio::time::timeout(IDLE_TIMEOUT, response.chunk()) => read,
        };
        let chunk = match next {
            Err(_) => return Err("The provider stopped sending data (idle timeout).".to_owned()),
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => return Err(describe_error(error)),
        };
        if bytes_mode {
            send_event(on_event, ProviderStreamEvent::Bytes { base64: STANDARD.encode(&chunk) })?;
        } else {
            carry.extend_from_slice(&chunk);
            drain_text(&mut carry, on_event)?;
        }
    }

    if !bytes_mode && !carry.is_empty() {
        // Any trailing bytes at EOF cannot be a split multibyte sequence anymore.
        let text = String::from_utf8_lossy(&carry).into_owned();
        send_event(on_event, ProviderStreamEvent::Data { text })?;
    }
    send_event(on_event, ProviderStreamEvent::End)?;
    Ok(())
}

fn cancelled(on_event: &Channel<ProviderStreamEvent>) -> Result<(), String> {
    let _ = on_event.send(ProviderStreamEvent::Error { message: "The request was cancelled.".to_owned() });
    Ok(())
}

/// Emits every complete UTF-8 code point currently buffered, keeping a trailing partial
/// multibyte sequence for the next chunk. Correct across arbitrary chunk boundaries.
fn drain_text(carry: &mut Vec<u8>, on_event: &Channel<ProviderStreamEvent>) -> Result<(), String> {
    loop {
        match std::str::from_utf8(carry) {
            Ok(text) => {
                if !text.is_empty() {
                    send_event(on_event, ProviderStreamEvent::Data { text: text.to_owned() })?;
                }
                carry.clear();
                return Ok(());
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                    send_event(on_event, ProviderStreamEvent::Data { text })?;
                }
                match error.error_len() {
                    // Genuinely invalid bytes: surface a replacement char and skip them.
                    Some(bad) => {
                        send_event(on_event, ProviderStreamEvent::Data { text: "\u{FFFD}".to_owned() })?;
                        carry.drain(..valid + bad);
                        if carry.is_empty() {
                            return Ok(());
                        }
                    }
                    // Incomplete trailing sequence: keep it for the next chunk.
                    None => {
                        carry.drain(..valid);
                        return Ok(());
                    }
                }
            }
        }
    }
}

fn send_event(on_event: &Channel<ProviderStreamEvent>, event: ProviderStreamEvent) -> Result<(), String> {
    on_event
        .send(event)
        .map_err(|error| format!("The response channel closed: {error}"))
}

/// Enforces the per-provider host allow-list and transport rules.
fn validate_target(provider: &str, url: &Url) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Credentials embedded in the URL are not allowed.".to_owned());
    }
    let host = url.host_str().unwrap_or("");
    if provider == "ollama" {
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err("Ollama requests must use http or https.".to_owned());
        }
        let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
        if !loopback {
            return Err("Ollama requests may only target 127.0.0.1, localhost or ::1.".to_owned());
        }
        return Ok(());
    }

    if url.scheme() != "https" {
        return Err("HTTPS is required for this provider.".to_owned());
    }
    let allowed = match provider {
        "openai" | "chatgpt" => "api.openai.com",
        "gemini" => "generativelanguage.googleapis.com",
        "anthropic" => "api.anthropic.com",
        "openrouter" => "openrouter.ai",
        "elevenlabs" => "api.elevenlabs.io",
        _ => return Err("Unknown provider.".to_owned()),
    };
    if !host.eq_ignore_ascii_case(allowed) {
        return Err(format!("{provider} requests may only go to {allowed}."));
    }
    Ok(())
}

/// Copies renderer headers, rejecting anything that could carry or override credentials.
fn sanitize_headers(headers: Option<&HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut out = HeaderMap::new();
    let Some(headers) = headers else {
        return Ok(out);
    };
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if is_forbidden_header(&lower) {
            return Err(format!("The {name} header is set by the host and cannot be supplied by the app."));
        }
        let header_name = HeaderName::from_bytes(lower.as_bytes())
            .map_err(|_| format!("The header name {name} is not valid."))?;
        let header_value = HeaderValue::from_str(value).map_err(|_| format!("The {name} header value is not valid."))?;
        out.insert(header_name, header_value);
    }
    Ok(out)
}

fn is_forbidden_header(lower: &str) -> bool {
    matches!(
        lower,
        "authorization" | "x-api-key" | "x-goog-api-key" | "xi-api-key" | "cookie" | "host"
    ) || lower.starts_with("proxy-")
}

/// Injects the provider credential as the correct header.
async fn inject_credential(provider: &str, headers: &mut HeaderMap, app: &tauri::AppHandle) -> Result<(), String> {
    match provider {
        "openai" | "openrouter" => {
            let key = stored_secret(provider)?;
            headers.insert(AUTHORIZATION, bearer(&key)?);
        }
        "chatgpt" => {
            let token = crate::chatgpt::access_token_for_request(app).await?;
            headers.insert(AUTHORIZATION, bearer(&token)?);
        }
        "gemini" => {
            let key = stored_secret("gemini")?;
            headers.insert(HeaderName::from_static("x-goog-api-key"), header_value(&key)?);
        }
        "anthropic" => {
            let key = stored_secret("anthropic")?;
            headers.insert(HeaderName::from_static("x-api-key"), header_value(&key)?);
            if !headers.contains_key("anthropic-version") {
                headers.insert(
                    HeaderName::from_static("anthropic-version"),
                    HeaderValue::from_static(DEFAULT_ANTHROPIC_VERSION),
                );
            }
        }
        "elevenlabs" => {
            let key = stored_secret("elevenlabs")?;
            headers.insert(HeaderName::from_static("xi-api-key"), header_value(&key)?);
        }
        "ollama" => {}
        _ => return Err("Unknown provider.".to_owned()),
    }
    Ok(())
}

fn stored_secret(provider: &str) -> Result<String, String> {
    miss_minute_agent::secrets::get_provider_secret(provider)
        .map_err(|error| format!("{error:#}"))?
        .ok_or_else(|| format!("No {provider} credential is stored. Add one in Settings."))
}

fn bearer(token: &str) -> Result<HeaderValue, String> {
    let mut value = header_value(&format!("Bearer {token}"))?;
    value.set_sensitive(true);
    Ok(value)
}

fn header_value(raw: &str) -> Result<HeaderValue, String> {
    let mut value = HeaderValue::from_str(raw).map_err(|_| "The stored credential is not a valid header value.".to_owned())?;
    value.set_sensitive(true);
    Ok(value)
}

/// Forwards response headers minus any that set cookies on the renderer.
fn safe_response_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (name, value) in headers {
        let lower = name.as_str().to_ascii_lowercase();
        if lower == "set-cookie" {
            continue;
        }
        if let Ok(text) = value.to_str() {
            out.insert(lower, text.to_owned());
        }
    }
    out
}

/// Reads a JSON body and converts an error status into a concise, secret-free message.
async fn read_json_or_error(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| "The provider returned a malformed response.".to_owned())?;
    if status.is_success() {
        Ok(body)
    } else {
        Err(api_error_message(&body, status.as_u16()))
    }
}

pub(crate) fn api_error_message(body: &Value, status: u16) -> String {
    if let Some(message) = body.get("error").and_then(|error| error.get("message")).and_then(Value::as_str) {
        return format!("Provider error {status}: {message}");
    }
    if let Some(detail) = body.get("detail").and_then(Value::as_str) {
        return format!("Provider error {status}: {detail}");
    }
    format!("The provider returned HTTP {status}.")
}

/// Maps a transport error to a short category without echoing the URL or body.
pub(crate) fn describe_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The provider request timed out.".to_owned()
    } else if error.is_connect() {
        "Could not connect to the provider.".to_owned()
    } else if error.is_body() || error.is_decode() {
        "The provider response could not be read.".to_owned()
    } else {
        "The provider request failed.".to_owned()
    }
}
