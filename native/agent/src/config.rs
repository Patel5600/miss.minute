use std::{
    collections::HashSet,
    fs,
    io::Write,
    net::IpAddr,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use reqwest::Url;
use serde::{Deserialize, Serialize};

pub const CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OwnerConsent {
    pub confirmed: bool,
    pub granted_at_unix_ms: i64,
    pub allowed_roots: Vec<PathBuf>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CapturePolicy {
    pub file_metadata: bool,
    pub file_contents: bool,
    pub follow_symlinks: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReasonerConfig {
    pub endpoint: String,
    pub model: String,
    /// Environment variable name only. The secret value is never stored in config.
    pub api_key_env: Option<String>,
    /// Required before a remote endpoint may receive local paths and metadata.
    pub share_local_metadata_with_remote: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentConfig {
    pub schema_version: u32,
    pub consent: OwnerConsent,
    pub capture: CapturePolicy,
    pub database_path: PathBuf,
    pub retention_days: u32,
    pub reasoner: Option<ReasonerConfig>,
}

pub fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn canonical_allowed_root(path: &Path) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path)
        .with_context(|| format!("Cannot resolve explicitly authorized path: {}", path.display()))?;

    if !canonical.is_dir() {
        bail!("Authorized path is not a directory: {}", canonical.display());
    }
    if canonical.parent().is_none_or(|parent| parent == canonical.as_path()) {
        bail!("A filesystem root cannot be added as a collection root");
    }
    Ok(canonical)
}

pub fn create_config(config_path: &Path, roots: &[PathBuf], confirmed: bool) -> Result<AgentConfig> {
    if !confirmed {
        bail!("Owner consent is required. Pass --confirm-owner-permission after reviewing every --allow-root path.");
    }
    if roots.is_empty() {
        bail!("At least one explicitly authorized --allow-root directory is required.");
    }
    if config_path.exists() {
        bail!("Refusing to overwrite existing configuration: {}", config_path.display());
    }

    let mut canonical_roots = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let canonical = canonical_allowed_root(root)?;
        if seen.insert(canonical.clone()) {
            canonical_roots.push(canonical);
        }
    }

    for (index, left) in canonical_roots.iter().enumerate() {
        for right in canonical_roots.iter().skip(index + 1) {
            if left.starts_with(right) || right.starts_with(left) {
                bail!(
                    "Overlapping collection roots are not allowed: {} and {}",
                    left.display(),
                    right.display()
                );
            }
        }
    }

    let requested_parent = config_path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(requested_parent)
        .with_context(|| format!("Cannot create config directory {}", requested_parent.display()))?;
    let canonical_parent = fs::canonicalize(requested_parent)
        .with_context(|| format!("Cannot resolve config directory {}", requested_parent.display()))?;
    let file_name = config_path.file_name().context("Config path must include a filename")?;
    let config_target = canonical_parent.join(file_name);
    let database_path = config_target.with_extension("sqlite3");

    for root in &canonical_roots {
        if config_target.starts_with(root) || database_path.starts_with(root) {
            bail!(
                "Keep the config and local database outside monitored roots. Move them outside {}.",
                root.display()
            );
        }
    }

    let config = AgentConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        consent: OwnerConsent {
            confirmed: true,
            granted_at_unix_ms: now_unix_ms(),
            allowed_roots: canonical_roots,
        },
        capture: CapturePolicy {
            file_metadata: true,
            file_contents: false,
            follow_symlinks: false,
        },
        database_path,
        retention_days: 30,
        reasoner: None,
    };

    save_config(config_path, &config)?;
    Ok(config)
}

pub fn load_config(path: &Path) -> Result<AgentConfig> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Cannot read agent configuration: {}", path.display()))?;
    let config: AgentConfig = serde_json::from_str(&raw)
        .with_context(|| format!("Invalid JSON configuration: {}", path.display()))?;
    let config_location = fs::canonicalize(path)
        .with_context(|| format!("Cannot resolve config location: {}", path.display()))?;
    if config.consent.allowed_roots.iter().any(|root| config_location.starts_with(root)) {
        bail!("Keep the agent config outside monitored roots to avoid collecting its own configuration.");
    }
    validate_config(&config)?;
    Ok(config)
}

pub fn save_config(path: &Path, config: &AgentConfig) -> Result<()> {
    validate_config(config)?;
    let serialized = serde_json::to_vec_pretty(config)?;
    let mut file = fs::File::create(path)
        .with_context(|| format!("Cannot write configuration: {}", path.display()))?;
    file.write_all(&serialized)?;
    file.write_all(b"\n")?;
    file.sync_all()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Cannot restrict config permissions: {}", path.display()))?;
    }
    Ok(())
}

pub fn validate_config(config: &AgentConfig) -> Result<()> {
    if config.schema_version != CONFIG_SCHEMA_VERSION {
        bail!("Unsupported config schema version {}", config.schema_version);
    }
    if !config.consent.confirmed || config.consent.allowed_roots.is_empty() {
        bail!("Owner consent or explicit collection roots are missing.");
    }
    if !config.capture.file_metadata {
        bail!("This agent build requires metadata capture to be explicitly enabled.");
    }
    if config.capture.file_contents {
        bail!("File-content capture is not implemented and must remain disabled.");
    }
    if config.capture.follow_symlinks {
        bail!("Symlink traversal is not implemented and must remain disabled.");
    }
    if !(1..=3650).contains(&config.retention_days) {
        bail!("retention_days must be between 1 and 3650.");
    }

    for root in &config.consent.allowed_roots {
        if !root.is_absolute() || !root.is_dir() {
            bail!("An authorized root is unavailable or not absolute: {}", root.display());
        }
        let canonical = fs::canonicalize(root)
            .with_context(|| format!("Cannot verify authorized root {}", root.display()))?;
        if canonical != *root || canonical.parent().is_none_or(|parent| parent == canonical.as_path()) {
            bail!("An authorized root changed or is a filesystem root: {}", root.display());
        }
    }

    if !config.database_path.is_absolute() {
        bail!("The local database path must be absolute.");
    }
    let database_parent = config.database_path.parent().context("Database path has no parent directory")?;
    let database_parent = fs::canonicalize(database_parent)
        .with_context(|| format!("Cannot resolve database directory {}", database_parent.display()))?;
    let database_name = config.database_path.file_name().context("Database path has no filename")?;
    let database_target = database_parent.join(database_name);
    if config.consent.allowed_roots.iter().any(|root| database_target.starts_with(root)) {
        bail!("The local database must be outside every monitored root.");
    }

    if let Some(reasoner) = &config.reasoner {
        validate_reasoner_config(reasoner)?;
    }
    Ok(())
}

pub fn validate_reasoner_config(reasoner: &ReasonerConfig) -> Result<()> {
    if reasoner.model.trim().is_empty() || reasoner.model.len() > 160 {
        bail!("Reasoner model name must contain 1 to 160 characters.");
    }

    let url = Url::parse(&reasoner.endpoint).context("Reasoner endpoint must be an absolute URL")?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        bail!("Reasoner endpoint must not contain credentials, query parameters or a fragment.");
    }

    let host = url.host_str().unwrap_or_default();
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().map(|address| address.is_loopback()).unwrap_or(false);

    if url.scheme() != "http" && url.scheme() != "https" {
        bail!("Reasoner endpoint must use HTTP or HTTPS.");
    }
    if url.scheme() == "http" && !loopback {
        bail!("Plain HTTP is allowed only for localhost or a loopback IP.");
    }
    if !loopback && !reasoner.share_local_metadata_with_remote {
        bail!("Remote reasoning requires explicit consent to send local file paths and metadata.");
    }
    if !loopback && url.scheme() != "https" {
        bail!("Remote reasoners must use HTTPS.");
    }
    if let Some(name) = &reasoner.api_key_env {
        if name.is_empty() || !name.chars().all(|character| character.is_ascii_alphanumeric() || character == '_') {
            bail!("api_key_env must be an environment-variable name, not a secret value.");
        }
    }
    Ok(())
}

pub fn configure_reasoner(
    config_path: &Path,
    endpoint: String,
    model: String,
    api_key_env: Option<String>,
    confirm_remote_egress: bool,
) -> Result<AgentConfig> {
    let mut config = load_config(config_path)?;
    let reasoner = ReasonerConfig {
        endpoint,
        model,
        api_key_env,
        share_local_metadata_with_remote: confirm_remote_egress,
    };
    validate_reasoner_config(&reasoner)?;
    config.reasoner = Some(reasoner);
    save_config(config_path, &config)?;
    Ok(config)
}

pub fn clear_reasoner(config_path: &Path) -> Result<AgentConfig> {
    let mut config = load_config(config_path)?;
    config.reasoner = None;
    save_config(config_path, &config)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_reasoner_requires_explicit_egress_consent() {
        let config = ReasonerConfig {
            endpoint: "https://example.invalid/v1/chat/completions".to_owned(),
            model: "test-model".to_owned(),
            api_key_env: Some("MISS_MINUTE_TEST_KEY".to_owned()),
            share_local_metadata_with_remote: false,
        };
        assert!(validate_reasoner_config(&config).is_err());
    }

    #[test]
    fn plain_http_is_restricted_to_loopback() {
        let local = ReasonerConfig {
            endpoint: "http://127.0.0.1:11434/v1/chat/completions".to_owned(),
            model: "local-model".to_owned(),
            api_key_env: None,
            share_local_metadata_with_remote: false,
        };
        assert!(validate_reasoner_config(&local).is_ok());

        let remote = ReasonerConfig {
            endpoint: "http://203.0.113.8/v1/chat/completions".to_owned(),
            model: "remote-model".to_owned(),
            api_key_env: None,
            share_local_metadata_with_remote: true,
        };
        assert!(validate_reasoner_config(&remote).is_err());
    }
}
