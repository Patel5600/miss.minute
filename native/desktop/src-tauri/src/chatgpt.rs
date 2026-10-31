//! "Sign in with ChatGPT" for open-source/local apps: OpenAI dynamic agent registration,
//! loopback PKCE, ID-token verification against the published JWKS, rotating-refresh-token
//! storage and revocation on sign-out. Tokens never leave the host; the renderer only ever
//! sees whether a session exists, the email, plan-usage flag and expiry.
//!
//! Endpoints are the fixed OpenAI auth-server URLs (they match its OpenID discovery document).
//! Token material is stored AES-256-GCM-sealed in the app data directory, keyed from the OS
//! vault. The stable host id and issued client id survive sign-out; tokens do not.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::Mutex;
use url::Url;

use crate::{crypto, loopback, util};

const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE_URL: &str = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS_URL: &str = "https://auth.openai.com/.well-known/jwks.json";
const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const MODELS_URL: &str = "https://api.openai.com/v1/models";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const AGENT_NAME_HINT: &str = "Miss Minutes";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const PREFERRED_PORT: u16 = 1455;
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh when fewer than two minutes of access-token life remain.
const REFRESH_SKEW_MS: i64 = 2 * 60 * 1000;
const FILE_KEY: &str = "chatgpt";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptAccount {
    pub signed_in: bool,
    pub email: Option<String>,
    /// True only when the granted scopes include `chatgpt.tokens.use.direct`.
    pub plan_usage: bool,
    pub expires_at_unix_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptModel {
    pub slug: String,
    pub display_name: String,
}

/// Non-secret, survives sign-out.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct HostState {
    host_id: String,
    client_id: Option<String>,
}

/// Secret; AES-GCM-sealed at rest; cleared on sign-out.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Credentials {
    issuer: String,
    subject: String,
    email: Option<String>,
    client_id: String,
    access_token: String,
    refresh_token: String,
    id_token: Option<String>,
    token_type: String,
    scopes: Vec<String>,
    access_expires_at_unix_ms: i64,
    obtained_at_unix_ms: i64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IdClaims {
    sub: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
}

/// Serializes token refreshes for the single signed-in session so two callers cannot race the
/// rotating refresh token.
fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn chatgpt_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = util::app_data_dir(app)?.join("chatgpt");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Cannot create the ChatGPT directory: {error}"))?;
    Ok(dir)
}

fn host_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(chatgpt_dir(app)?.join("host.json"))
}

fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(chatgpt_dir(app)?.join("credentials.bin"))
}

fn load_host(app: &AppHandle) -> Result<HostState, String> {
    let path = host_path(app)?;
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(state) = serde_json::from_slice::<HostState>(&bytes) {
            if !state.host_id.is_empty() {
                return Ok(state);
            }
        }
    }
    // First launch for this host: mint and persist a stable UUID-based host id.
    let state = HostState {
        host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
        client_id: None,
    };
    save_host(app, &state)?;
    Ok(state)
}

fn save_host(app: &AppHandle, state: &HostState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| format!("Cannot serialize host state: {error}"))?;
    util::atomic_write(&host_path(app)?, &bytes)
}

fn seal_key() -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    miss_minute_agent::secrets::get_or_create_file_key(FILE_KEY).map_err(|error| format!("{error:#}"))
}

fn load_credentials(app: &AppHandle) -> Result<Option<Credentials>, String> {
    let path = credentials_path(app)?;
    let blob = match std::fs::read(&path) {
        Ok(blob) => blob,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read the ChatGPT credentials: {error}")),
    };
    let key = seal_key()?;
    let plaintext = crypto::open(&key, &blob)?;
    serde_json::from_slice::<Credentials>(&plaintext)
        .map(Some)
        .map_err(|_| "The stored ChatGPT credentials are corrupt.".to_owned())
}

fn save_credentials(app: &AppHandle, credentials: &Credentials) -> Result<(), String> {
    let key = seal_key()?;
    let plaintext = serde_json::to_vec(credentials).map_err(|error| format!("Cannot serialize credentials: {error}"))?;
    let blob = crypto::seal(&key, &plaintext)?;
    util::atomic_write(&credentials_path(app)?, &blob)
}

fn clear_credentials(app: &AppHandle) -> Result<(), String> {
    let path = credentials_path(app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove the ChatGPT credentials: {error}")),
    }
}

/// Whether a ChatGPT session is stored. Used by `provider_has_credential`.
pub fn is_signed_in(app: &AppHandle) -> bool {
    credentials_path(app)
        .map(|path| path.exists())
        .unwrap_or(false)
}

fn account_view(credentials: &Credentials) -> ChatGptAccount {
    ChatGptAccount {
        signed_in: true,
        email: credentials.email.clone(),
        plan_usage: credentials.scopes.iter().any(|scope| scope == PLAN_SCOPE),
        expires_at_unix_ms: Some(credentials.access_expires_at_unix_ms),
    }
}

/// Opens the system browser and resolves when the loopback callback completes (or times out).
#[tauri::command]
pub async fn chatgpt_sign_in(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<ChatGptAccount, String> {
    crate::require_dashboard(&window)?;

    let host = load_host(&app)?;
    let returning_client = host.client_id.clone();
    let existing = load_credentials(&app)?;

    let (verifier, challenge) = crypto::pkce_pair()?;
    let state_token = crypto::random_token(32)?;
    let nonce = crypto::random_token(32)?;

    // The listener must be live before the browser opens so the redirect never races it.
    let listener = loopback::bind_preferred(PREFERRED_PORT).await?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read the callback port: {error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/auth/callback");

    let client_id = returning_client.clone().unwrap_or_else(|| DYNAMIC_CLIENT.to_owned());
    let mut url = Url::parse(AUTHORIZE_URL).map_err(|_| "Internal URL error.".to_owned())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", &client_id)
            .append_pair("ext_agent_host_id", &host.host_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("scope", SCOPE)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &state_token)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        if returning_client.is_none() {
            // The display name is sent only on first-time dynamic registration.
            query.append_pair("agent_name_hint", AGENT_NAME_HINT);
        } else if let Some(credentials) = &existing {
            // Reauthorization hints identify the same account and skip the picker.
            if let Some(id_token) = &credentials.id_token {
                query.append_pair("id_token_hint", id_token);
            }
            if let Some(email) = &credentials.email {
                query.append_pair("login_hint", email);
            }
        }
    }
    let authorize_url = url.to_string();

    // Never logged: this URL may carry id_token_hint/login_hint.
    util::open_in_browser(&authorize_url)?;

    let callback = loopback::wait_for_callback(&listener, "/auth/callback", SIGN_IN_TIMEOUT).await?;

    if callback.query.get("state").map(String::as_str) != Some(state_token.as_str()) {
        return Err("The sign-in response did not match this request. Please try again.".to_owned());
    }
    if let Some(error) = callback.query.get("error") {
        if error == "access_denied" {
            return Err("ChatGPT sign-in was declined.".to_owned());
        }
        return Err(format!("ChatGPT sign-in failed: {error}"));
    }
    let code = callback
        .query
        .get("code")
        .cloned()
        .ok_or_else(|| "The callback did not include an authorization code.".to_owned())?;

    // Resolve the client id to use for the exchange, and persist a newly issued one *before*
    // exchanging so an interrupted first registration is not silently lost.
    let issued = callback.query.get("client_id").cloned();
    let client_id = match &returning_client {
        Some(previous) => {
            if let Some(issued) = &issued {
                if issued != previous {
                    return Err("The sign-in returned a different client registration than expected.".to_owned());
                }
            }
            previous.clone()
        }
        None => {
            let issued =
                issued.ok_or_else(|| "Registration did not complete (no client id was issued).".to_owned())?;
            let mut host = host.clone();
            host.client_id = Some(issued.clone());
            save_host(&app, &host)?;
            issued
        }
    };

    let client = util::http_client(Duration::from_secs(15), true)?;
    let token = post_token(
        &client,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", &client_id),
            ("code", &code),
            ("code_verifier", &verifier),
            ("redirect_uri", &redirect_uri),
            ("resource", RESOURCE),
        ],
    )
    .await?;

    let id_token = token
        .id_token
        .clone()
        .ok_or_else(|| "The token response did not include an ID token.".to_owned())?;
    let claims = verify_id_token(&client, &id_token, &client_id, &nonce).await?;

    if let Some(previous) = &existing {
        if previous.subject != claims.sub {
            return Err("The verified account did not match the saved account.".to_owned());
        }
    }

    let scopes: Vec<String> = token
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let now = util::now_ms();
    let credentials = Credentials {
        issuer: ISSUER.to_owned(),
        subject: claims.sub,
        email: claims.email,
        client_id,
        access_token: token.access_token,
        refresh_token: token.refresh_token.unwrap_or_default(),
        id_token: Some(id_token),
        token_type: token.token_type.unwrap_or_else(|| "Bearer".to_owned()),
        scopes,
        access_expires_at_unix_ms: now + token.expires_in.unwrap_or(3600) * 1000,
        obtained_at_unix_ms: now,
    };
    save_credentials(&app, &credentials)?;
    Ok(account_view(&credentials))
}

#[tauri::command]
pub fn chatgpt_account(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<ChatGptAccount, String> {
    crate::require_dashboard(&window)?;
    Ok(load_credentials(&app)?.map(|credentials| account_view(&credentials)).unwrap_or_default())
}

#[tauri::command]
pub async fn chatgpt_sign_out(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    crate::require_dashboard(&window)?;
    // Serialize against refreshes so a concurrent request cannot resurrect cleared tokens.
    let _guard = refresh_lock().lock().await;
    if let Some(credentials) = load_credentials(&app)? {
        if !credentials.refresh_token.is_empty() {
            let client = util::http_client(Duration::from_secs(15), true)?;
            // Best effort: revoke the renewable session, then clear locally regardless.
            let body = util::form_encode(&[
                ("token", &credentials.refresh_token),
                ("token_type_hint", "refresh_token"),
                ("client_id", &credentials.client_id),
            ]);
            let _ = client
                .post(REVOKE_URL)
                .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(body)
                .send()
                .await;
        }
    }
    clear_credentials(&app)
}

#[tauri::command]
pub async fn chatgpt_models(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Vec<ChatGptModel>, String> {
    crate::require_dashboard(&window)?;
    let token = access_token_for_request(&app).await?;
    let client = util::http_client(Duration::from_secs(15), true)?;
    let response = client
        .get(MODELS_URL)
        .bearer_auth(token)
        .send()
        .await
        .map_err(crate::provider::describe_error)?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| "OpenAI returned a malformed model list.".to_owned())?;
    if !status.is_success() {
        return Err(crate::provider::api_error_message(&body, status.as_u16()));
    }
    Ok(parse_models(&body))
}

/// Returns a valid access token, refreshing under the serialization lock when it is close to
/// expiry. Used by the sign-in flow result and by the provider proxy for `chatgpt` requests.
pub(crate) async fn access_token_for_request(app: &AppHandle) -> Result<String, String> {
    let _guard = refresh_lock().lock().await;
    let mut credentials = load_credentials(app)?.ok_or_else(|| "Not signed in to ChatGPT.".to_owned())?;
    let now = util::now_ms();
    if credentials.access_expires_at_unix_ms - now > REFRESH_SKEW_MS {
        return Ok(credentials.access_token);
    }
    if credentials.refresh_token.is_empty() {
        return Err("The ChatGPT session expired. Please sign in again.".to_owned());
    }

    let client = util::http_client(Duration::from_secs(15), true)?;
    let refreshed = post_token(
        &client,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &credentials.client_id),
            ("refresh_token", &credentials.refresh_token),
            ("resource", RESOURCE),
        ],
    )
    .await?;

    credentials.access_token = refreshed.access_token;
    if let Some(rotated) = refreshed.refresh_token {
        // The refresh token rotates on every use; store the replacement.
        credentials.refresh_token = rotated;
    }
    if let Some(scope) = refreshed.scope {
        credentials.scopes = scope.split_whitespace().map(str::to_owned).collect();
    }
    credentials.access_expires_at_unix_ms = util::now_ms() + refreshed.expires_in.unwrap_or(3600) * 1000;
    save_credentials(app, &credentials)?;
    Ok(credentials.access_token)
}

/// POSTs a form-encoded grant to the token endpoint and parses the response. Error messages
/// carry only the HTTP status and the OAuth error code, never token material.
async fn post_token(client: &reqwest::Client, params: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let body = util::form_encode(params);
    let response = client
        .post(TOKEN_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(body)
        .send()
        .await
        .map_err(crate::provider::describe_error)?;
    let status = response.status();
    let text = response.text().await.map_err(|_| "Malformed token response.".to_owned())?;
    if !status.is_success() {
        let code = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_owned));
        return Err(match code {
            Some(code) => format!("Token request failed (HTTP {}): {code}", status.as_u16()),
            None => format!("Token request failed (HTTP {}).", status.as_u16()),
        });
    }
    serde_json::from_str::<TokenResponse>(&text).map_err(|_| "Malformed token response.".to_owned())
}

/// Verifies the ID token signature against the published JWKS and checks issuer, audience,
/// expiry and the per-attempt nonce.
async fn verify_id_token(
    client: &reqwest::Client,
    id_token: &str,
    client_id: &str,
    nonce: &str,
) -> Result<IdClaims, String> {
    let jwks: Value = client
        .get(JWKS_URL)
        .send()
        .await
        .map_err(crate::provider::describe_error)?
        .json()
        .await
        .map_err(|_| "Could not read the OpenAI signing keys.".to_owned())?;

    let header = decode_header(id_token).map_err(|_| "The ID token header is unreadable.".to_owned())?;
    let kid = header.kid.ok_or_else(|| "The ID token has no key id.".to_owned())?;
    let jwk = jwks
        .get("keys")
        .and_then(Value::as_array)
        .and_then(|keys| {
            keys.iter().find(|key| {
                key.get("kid").and_then(Value::as_str) == Some(kid.as_str())
                    && key.get("kty").and_then(Value::as_str) == Some("RSA")
            })
        })
        .ok_or_else(|| "No matching OpenAI signing key was found.".to_owned())?;
    let modulus = jwk.get("n").and_then(Value::as_str).ok_or_else(|| "Malformed signing key.".to_owned())?;
    let exponent = jwk.get("e").and_then(Value::as_str).ok_or_else(|| "Malformed signing key.".to_owned())?;

    let decoding_key =
        DecodingKey::from_rsa_components(modulus, exponent).map_err(|_| "Malformed signing key.".to_owned())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client_id]);
    validation.validate_exp = true;

    let data = decode::<IdClaims>(id_token, &decoding_key, &validation).map_err(map_jwt_error)?;
    if data.claims.nonce.as_deref() != Some(nonce) {
        return Err("The ID token nonce did not match this sign-in.".to_owned());
    }
    if data.claims.sub.is_empty() {
        return Err("The ID token did not identify an account.".to_owned());
    }
    Ok(data.claims)
}

fn map_jwt_error(error: jsonwebtoken::errors::Error) -> String {
    use jsonwebtoken::errors::ErrorKind;
    match error.kind() {
        ErrorKind::InvalidSignature => "The ID token signature is invalid.".to_owned(),
        ErrorKind::ExpiredSignature => "The ID token has expired.".to_owned(),
        ErrorKind::InvalidIssuer => "The ID token issuer is not OpenAI.".to_owned(),
        ErrorKind::InvalidAudience => "The ID token was issued for a different app.".to_owned(),
        _ => "The ID token could not be validated.".to_owned(),
    }
}

/// Keeps catalog entries marked for display and maps both the SIWC `models` shape and the
/// standard `data` shape to `{slug, display_name}`.
fn parse_models(body: &Value) -> Vec<ChatGptModel> {
    let mut models = Vec::new();
    if let Some(entries) = body.get("models").and_then(Value::as_array) {
        for entry in entries {
            if entry.get("visibility").and_then(Value::as_str) != Some("list") {
                continue;
            }
            let slug = entry
                .get("slug")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str);
            if let Some(slug) = slug {
                let display_name = entry.get("display_name").and_then(Value::as_str).unwrap_or(slug);
                models.push(ChatGptModel {
                    slug: slug.to_owned(),
                    display_name: display_name.to_owned(),
                });
            }
        }
    } else if let Some(entries) = body.get("data").and_then(Value::as_array) {
        for entry in entries {
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                models.push(ChatGptModel {
                    slug: id.to_owned(),
                    display_name: id.to_owned(),
                });
            }
        }
    }
    models
}
