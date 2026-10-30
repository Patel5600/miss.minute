use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use keyring::Entry;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

const DATABASE_SERVICE: &str = "com.patel5600.missminute.database";
const PROVIDER_SERVICE: &str = "com.patel5600.missminute.providers";

fn database_account(path: &Path) -> Result<String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let canonical_parent = std::fs::canonicalize(parent)
        .with_context(|| format!("Cannot canonicalize database directory {}", parent.display()))?;
    let filename = path.file_name().context("Database path has no filename")?;
    let mut identity = canonical_parent.as_os_str().to_string_lossy().as_bytes().to_vec();
    identity.push(b'/');
    identity.extend_from_slice(filename.to_string_lossy().as_bytes());
    let digest = Sha256::digest(&identity);
    let hex = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    Ok(format!("database-{hex}"))
}

fn provider_entry(provider: &str) -> Result<Entry> {
    match provider {
        "openai" | "gemini" | "anthropic" | "ollama" | "elevenlabs" => {}
        _ => bail!("Unsupported credential provider."),
    }
    Entry::new(PROVIDER_SERVICE, provider).context("Cannot access the operating-system credential vault")
}

pub fn existing_database_key(path: &Path) -> Result<Option<Zeroizing<Vec<u8>>>> {
    let account = database_account(path)?;
    let entry = Entry::new(DATABASE_SERVICE, &account)
        .context("Cannot access the operating-system credential vault")?;
    match entry.get_secret() {
        Ok(secret) if secret.len() == 32 => Ok(Some(Zeroizing::new(secret))),
        Ok(_) => bail!("The stored database key has an invalid length. Refusing to replace it."),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("Cannot read the database key from the operating-system vault"),
    }
}

pub fn create_database_key(path: &Path) -> Result<Zeroizing<Vec<u8>>> {
    let account = database_account(path)?;
    let entry = Entry::new(DATABASE_SERVICE, &account)
        .context("Cannot access the operating-system credential vault")?;
    let mut secret = Zeroizing::new(Vec::with_capacity(32));
    secret.extend_from_slice(Uuid::new_v4().as_bytes());
    secret.extend_from_slice(Uuid::new_v4().as_bytes());
    entry.set_secret(secret.as_slice())
        .context("Cannot persist the database key in the operating-system credential vault")?;
    Ok(secret)
}

pub fn set_provider_secret(provider: &str, secret: &str) -> Result<()> {
    if secret.trim().is_empty() || secret.len() > 4096 || secret.contains('\0') {
        bail!("Provider credential must contain 1 to 4096 bytes and no NUL.");
    }
    provider_entry(provider)?.set_secret(secret.as_bytes())
        .context("Cannot persist provider credential in the operating-system vault")
}

pub fn get_provider_secret(provider: &str) -> Result<Option<String>> {
    let entry = provider_entry(provider)?;
    match entry.get_secret() {
        Ok(secret) => {
            if secret.len() > 4096 {
                bail!("Stored provider credential exceeds the supported limit.");
            }
            String::from_utf8(secret).map(Some).context("Stored provider credential is not valid UTF-8")
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("Cannot read provider credential from the operating-system vault"),
    }
}

pub fn delete_provider_secret(provider: &str) -> Result<()> {
    match provider_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("Cannot delete provider credential from the operating-system vault"),
    }
}

pub fn migration_paths(path: &Path) -> (PathBuf, PathBuf) {
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(".cipher-migration.tmp");
    let mut backup = path.as_os_str().to_os_string();
    backup.push(".plaintext-backup");
    (PathBuf::from(temporary), PathBuf::from(backup))
}
