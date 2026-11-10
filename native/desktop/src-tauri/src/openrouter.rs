//! OpenRouter pairing (OAuth PKCE). Two modes:
//!   - "loopback": the host listens on 127.0.0.1 and the browser redirects back automatically;
//!   - "code": no callback; OpenRouter shows a one-time code the owner pastes into the app.
//! The resulting user-scoped API key goes straight into the OS vault. The PKCE verifier lives
//! only in host memory and is discarded after use or after ten minutes.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::net::TcpListener;
use url::Url;

use crate::{loopback, util};

const VERIFIER_TTL_MS: i64 = 10 * 60 * 1000;
const EXCHANGE_URL: &str = "https://openrouter.ai/api/v1/auth/keys";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterPairing {
    pub authorize_url: String,
}

struct Pending {
    verifier: String,
    mode: String,
    created_at_ms: i64,
    listener: Option<TcpListener>,
}

/// Holds the single in-flight pairing attempt. Starting a new one replaces any previous.
#[derive(Default)]
pub struct OpenRouterState {
    pending: Mutex<Option<Pending>>,
}

#[tauri::command]
pub async fn openrouter_pair_start(
    mode: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, OpenRouterState>,
) -> Result<OpenRouterPairing, String> {
    crate::require_dashboard(&window)?;

    let (verifier, challenge) = crate::crypto::pkce_pair()?;
    let mut url = Url::parse("https://openrouter.ai/auth").map_err(|_| "Internal URL error.".to_owned())?;

    let listener = match mode.as_str() {
        "loopback" => {
            let listener = loopback::bind_preferred(0).await?;
            let port = listener
                .local_addr()
                .map_err(|error| format!("Could not read the callback port: {error}"))?
                .port();
            // OpenRouter accepts localhost callbacks on any port.
            let callback = format!("http://localhost:{port}/callback");
            url.query_pairs_mut()
                .append_pair("callback_url", &callback)
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256");
            Some(listener)
        }
        "code" => {
            // Headless mode: no callback. The code shown on the page is useless without the
            // verifier, so the challenge is required here.
            url.query_pairs_mut()
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256");
            None
        }
        _ => return Err("Pairing mode must be \"loopback\" or \"code\".".to_owned()),
    };

    let authorize_url = url.to_string();

    {
        let mut slot = state
            .pending
            .lock()
            .map_err(|_| "Pairing state is unavailable.".to_owned())?;
        *slot = Some(Pending {
            verifier,
            mode,
            created_at_ms: util::now_ms(),
            listener,
        });
    }

    // Best effort: the UI also receives the URL so it can offer a manual link.
    let _ = util::open_in_browser(&authorize_url);
    Ok(OpenRouterPairing { authorize_url })
}

/// Loopback mode: waits for the redirect. Code mode: exchanges the pasted `code`.
#[tauri::command]
pub async fn openrouter_pair_complete(
    code: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, OpenRouterState>,
) -> Result<(), String> {
    crate::require_dashboard(&window)?;

    // Take the pending attempt out so the verifier is single-use regardless of outcome.
    let pending = {
        let mut slot = state
            .pending
            .lock()
            .map_err(|_| "Pairing state is unavailable.".to_owned())?;
        slot.take()
    };
    let pending = pending.ok_or_else(|| "Start pairing before completing it.".to_owned())?;

    if util::now_ms() - pending.created_at_ms > VERIFIER_TTL_MS {
        return Err("This pairing attempt expired. Please start again.".to_owned());
    }

    let code = match pending.mode.as_str() {
        "loopback" => {
            let listener = pending
                .listener
                .ok_or_else(|| "The loopback listener was lost. Start again.".to_owned())?;
            let callback = loopback::wait_for_callback(&listener, "/callback", Duration::from_secs(300)).await?;
            if callback.query.contains_key("error") {
                return Err("OpenRouter sign-in was cancelled.".to_owned());
            }
            callback
                .query
                .get("code")
                .cloned()
                .ok_or_else(|| "The callback did not include an authorization code.".to_owned())?
        }
        "code" => code
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Paste the code OpenRouter showed you.".to_owned())?,
        _ => return Err("Unknown pairing mode.".to_owned()),
    };

    let client = util::http_client(Duration::from_secs(15), true)?;
    let response = client
        .post(EXCHANGE_URL)
        .json(&serde_json::json!({
            "code": code,
            "code_verifier": pending.verifier,
            "code_challenge_method": "S256",
        }))
        .send()
        .await
        .map_err(crate::provider::describe_error)?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| "OpenRouter returned a malformed response.".to_owned())?;
    if !status.is_success() {
        return Err(crate::provider::api_error_message(&body, status.as_u16()));
    }

    let key = body
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "OpenRouter did not return an API key.".to_owned())?;

    miss_minute_agent::secrets::set_provider_secret("openrouter", key).map_err(|error| format!("{error:#}"))?;
    Ok(())
}
