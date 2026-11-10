//! Native desktop owner authentication. Windows uses the OS WebAuthn API with platform
//! user verification (Windows Hello); the renderer can request a ceremony but cannot mint a session.

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use miss_minute_identity::{
    AuthenticationAssurance, AuthorizationDecision, AuthorityEngine, Capability, CommandOrigin, CommandRequest,
    DeviceCredentialRegistration, DeviceId, DevicePlatform, OwnerId, Risk, capabilities,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const RP_ID: &str = "missminutes.local";
const ORIGIN: &str = "https://missminutes.local";
const OWNER_CAPABILITIES: &[&str] = &[
    capabilities::GENERAL_CONVERSATION,
    capabilities::PUBLIC_INFORMATION,
    capabilities::HARMLESS_TASK,
    capabilities::PRIVATE_MEMORY_READ,
    capabilities::PRIVATE_MEMORY_WRITE,
    capabilities::PRIVATE_FILES_READ,
    capabilities::SETTINGS_MODIFY,
    capabilities::AI_PROVIDER_USE,
    capabilities::DEVICE_CONTROL,
    capabilities::OWNER_PROFILE_MODIFY,
];

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredOwnerDevice {
    owner_id: String,
    device_id: String,
    credential_id: Vec<u8>,
    public_key: Vec<u8>,
    #[serde(default)]
    trusted_devices: Vec<StoredTrustedDevice>,
    #[serde(default)]
    recovery_public_key: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredTrustedDevice {
    device_id: String,
    platform: DevicePlatform,
    public_key: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerStatus {
    pub enrolled: bool,
    pub authenticated: bool,
    pub platform: &'static str,
}

pub struct DesktopAuthority {
    file: PathBuf,
    device: Option<StoredOwnerDevice>,
    engine: AuthorityEngine,
    session_id: Option<String>,
}

impl DesktopAuthority {
    pub fn load(app_data: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_data)
            .map_err(|e| format!("Cannot create owner-state directory: {e}"))?;
        let file = app_data.join("owner-identity.sealed");
        let device = if file.exists() {
            let blob =
                std::fs::read(&file).map_err(|e| format!("Cannot read owner enrollment: {e}"))?;
            if blob.len() > 32 * 1024 {
                return Err("Owner enrollment record exceeds its size limit.".into());
            }
            let key = miss_minute_agent::secrets::get_or_create_file_key("owner-identity")
                .map_err(|e| format!("Cannot access the OS-protected owner key: {e:#}"))?;
            let plaintext = crate::crypto::open(&key, &blob)?;
            Some(
                serde_json::from_slice::<StoredOwnerDevice>(&plaintext)
                    .map_err(|e| format!("Owner enrollment record is invalid: {e}"))?,
            )
        } else {
            None
        };
        let engine = match &device {
            Some(record) => engine_for_device(record)
                .map_err(|e| format!("Cannot restore trusted Windows device: {e}"))?,
            None => AuthorityEngine::new(),
        };
        Ok(Self {
            file,
            device,
            engine,
            session_id: None,
        })
    }

    pub fn status(&mut self) -> OwnerStatus {
        let authenticated = self
            .session_id
            .as_deref()
            .is_some_and(|id| self.engine.owner_session_active(id, Instant::now()));
        if !authenticated {
            self.session_id = None;
        }
        OwnerStatus {
            enrolled: self.device.is_some(),
            authenticated,
            platform: if cfg!(windows) {
                "windows-webauthn"
            } else {
                "unsupported"
            },
        }
    }

    pub fn lock(&mut self) {
        self.engine.lock();
        self.session_id = None;
    }

    pub fn authorize(
        &mut self,
        capability: &str,
        origin: CommandOrigin,
        risk: Risk,
        requires_confirmation: bool,
    ) -> Result<(), String> {
        let session = self
            .session_id
            .as_deref()
            .ok_or_else(|| "Unlock Miss Minutes with Windows Hello first.".to_owned())?;
        if !self.engine.owner_session_active(session, Instant::now()) {
            self.lock();
            return Err("The owner session expired. Unlock Miss Minutes again.".to_owned());
        }
        let request = CommandRequest {
            origin,
            capability: Capability::new(capability)
                .map_err(|e| format!("Invalid capability: {e:?}"))?,
            target: "desktop".into(),
            risk,
            requires_confirmation,
        };
        let result = self.engine.authorize(session, &request, Instant::now());
        match result.decision {
            miss_minute_identity::AuthorizationDecision::Allow => Ok(()),
            miss_minute_identity::AuthorizationDecision::ConfirmationRequired => {
                Err("This operation needs an explicit owner confirmation.".into())
            }
            miss_minute_identity::AuthorizationDecision::FreshAuthenticationRequired => {
                Err("This operation needs a fresh Windows Hello verification.".into())
            }
            miss_minute_identity::AuthorizationDecision::Deny => Err(format!(
                "Owner policy denied this operation ({})",
                result.reason
            )),
        }
    }

    /// Authorizes a proposal using its stored risk after a native confirmation was accepted.
    /// High-risk commands are stepped up by the caller before confirmation is committed.
    pub fn authorize_confirmed(
        &mut self,
        capability: &str,
        risk: Risk,
        owner_confirmed: bool,
    ) -> Result<(), String> {
        let session = self.session_id.as_deref()
            .ok_or_else(|| "Unlock Miss Minutes with Windows Hello first.".to_owned())?;
        if !self.engine.owner_session_active(session, Instant::now()) {
            self.lock();
            return Err("The owner session expired. Unlock Miss Minutes again.".to_owned());
        }
        let request = CommandRequest {
            origin: CommandOrigin::UserInput,
            capability: Capability::new(capability)
                .map_err(|error| format!("Invalid capability: {error:?}"))?,
            target: "desktop".into(),
            risk,
            requires_confirmation: false,
        };
        let result = self.engine.authorize(session, &request, Instant::now());
        match result.decision {
            AuthorizationDecision::Allow => Ok(()),
            AuthorizationDecision::ConfirmationRequired if owner_confirmed => Ok(()),
            AuthorizationDecision::ConfirmationRequired => Err("This operation needs explicit owner confirmation.".into()),
            AuthorizationDecision::FreshAuthenticationRequired => Err("This operation needs a fresh Windows Hello verification.".into()),
            AuthorizationDecision::Deny => Err(format!("Owner policy denied this operation ({})", result.reason)),
        }
    }

    /// Invalidates the current session before a fresh Windows Hello step-up ceremony.
    pub fn require_step_up(&mut self, window: &tauri::WebviewWindow) -> Result<OwnerStatus, String> {
        let session = self.session_id.as_deref()
            .ok_or_else(|| "Unlock Miss Minutes with Windows Hello first.".to_owned())?;
        if !self.engine.require_step_up(session, Instant::now()) {
            self.lock();
            return Err("The owner session expired. Unlock Miss Minutes again.".to_owned());
        }
        self.session_id = None;
        self.authenticate(window)
    }

    pub fn enroll(&mut self, window: &tauri::WebviewWindow) -> Result<OwnerStatus, String> {
        if self.device.is_some() {
            return Err("This installation already has an owner device. Use authenticated pairing to add another.".into());
        }
        #[cfg(windows)]
        let record = windows_auth::register(window)?;
        #[cfg(not(windows))]
        let record: StoredOwnerDevice =
            return Err("Windows WebAuthn is unavailable on this desktop platform.".into());

        // Validate the credential and owner identity in an isolated engine before committing any
        // enrollment data. A rejected WebAuthn credential must not leave a poisoned disk record.
        let next_engine = engine_for_device(&record)?;
        let serialized = serde_json::to_vec(&record)
            .map_err(|e| format!("Cannot encode the enrollment record: {e}"))?;
        let key = miss_minute_agent::secrets::get_or_create_file_key("owner-identity")
            .map_err(|e| format!("Cannot access the OS-protected owner key: {e:#}"))?;
        let sealed = crate::crypto::seal(&key, &serialized)?;
        let temporary = self
            .file
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("Cannot create temporary owner enrollment: {e}"))?;
        if let Err(error) = file.write_all(&sealed).and_then(|_| file.sync_all()) {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!(
                "Cannot persist temporary owner enrollment: {error}"
            ));
        }
        drop(file);
        if let Err(error) = std::fs::rename(&temporary, &self.file) {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("Cannot commit owner enrollment: {error}"));
        }
        self.engine = next_engine;
        self.device = Some(record);
        Ok(self.status())
    }

    /// Approves a public-only Android pairing request and returns a signed offline receipt.
    /// No target device becomes trusted until its own Keystore key validates the receipt.
    pub fn approve_android_pairing(
        &mut self,
        window: &tauri::WebviewWindow,
        request_json: &str,
    ) -> Result<String, String> {
        let record = self
            .device
            .clone()
            .ok_or_else(|| "Enroll this desktop with Windows Hello first.".to_owned())?;
        let session_id = self
            .session_id
            .as_deref()
            .ok_or_else(|| "Unlock the owner session before pairing a device.".to_owned())?;
        if !self.engine.owner_session_active(session_id, Instant::now()) {
            self.lock();
            return Err("The owner session expired. Unlock Miss Minutes again.".into());
        }
        if request_json.len() > 8 * 1024 {
            return Err("The pairing request exceeds the 8 KiB size limit.".into());
        }
        let request: PairingRequest = serde_json::from_str(request_json)
            .map_err(|error| format!("Pairing request is invalid: {error}"))?;
        if request.kind != "miss-minutes-pair-request-v1"
            || request.platform != "android"
            || request.device_id.len() < 16
            || request.device_id.len() > 64
            || !request
                .device_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err("This is not a valid Android Miss Minutes pairing request.".into());
        }
        let target_key = STANDARD
            .decode(request.public_key)
            .map_err(|_| "Pairing request public key is not valid Base64.".to_owned())?;
        if target_key.len() != 65 || target_key[0] != 4 {
            return Err(
                "Pairing request does not contain an uncompressed P-256 public key.".into(),
            );
        }

        let challenge = self
            .engine
            .begin_device_pairing(
                session_id,
                DeviceId(request.device_id.clone()),
                DevicePlatform::Android,
                target_key.clone(),
            )
            .map_err(|error| format!("Cannot create pairing challenge: {error:?}"))?;
        #[cfg(windows)]
        let assertion =
            match windows_auth::assertion(window, &record.credential_id, &challenge.bytes) {
                Ok(proof) => proof,
                Err(error) => {
                    self.engine.cancel_device_pairing();
                    return Err(error);
                }
            };
        #[cfg(not(windows))]
        let assertion: Vec<u8> = {
            self.engine.cancel_device_pairing();
            return Err("Windows Hello pairing approval is only available on Windows.".into());
        };

        let verified = match miss_minute_identity::verify_webauthn_assertion(
            &record.public_key,
            &record.credential_id,
            RP_ID,
            ORIGIN,
            &challenge.bytes,
            &assertion,
        ) {
            Ok(proof) => proof,
            Err(error) => {
                self.engine.cancel_device_pairing();
                return Err(format!(
                    "Windows Hello pairing assertion was rejected: {error:?}"
                ));
            }
        };
        let proof: serde_json::Value = serde_json::from_slice(&assertion)
            .map_err(|error| format!("Cannot encode Windows Hello pairing proof: {error}"))?;
        self.engine
            .complete_device_pairing(&challenge.challenge_id, verified)
            .map_err(|error| format!("Pairing was rejected: {error:?}"))?;

        let mut updated = record.clone();
        updated.trusted_devices.push(StoredTrustedDevice {
            device_id: request.device_id.clone(),
            platform: DevicePlatform::Android,
            public_key: target_key.clone(),
        });
        if let Err(error) = self.persist_record(&updated) {
            // Never retain a newly trusted key in memory if the protected registry could not
            // commit it. Rebuild from the prior disk record and require a fresh unlock.
            self.engine = engine_for_device(&record)?;
            self.session_id = None;
            return Err(error);
        }
        self.device = Some(updated);

        let fingerprint = pairing_source_fingerprint(
            &challenge.owner_id.0,
            &challenge.source_device_id.0,
            &record.public_key,
        );
        Ok(serde_json::json!({
            "type": "miss-minutes-pair-receipt-v1",
            "ownerId": challenge.owner_id.0,
            "sourceDeviceId": challenge.source_device_id.0,
            "sourcePlatform": "windows",
            "sourcePublicKey": STANDARD.encode(&record.public_key),
            "sourceFingerprint": fingerprint,
            "sourceCredentialId": STANDARD.encode(&record.credential_id),
            "targetDeviceId": challenge.target_device_id.0,
            "platform": "android",
            "targetPublicKey": STANDARD.encode(&target_key),
            "challengeId": challenge.challenge_id,
            "nonce": STANDARD.encode(&challenge.nonce),
            "challenge": STANDARD.encode(&challenge.bytes),
            "webauthnAssertion": proof,
            "recoveryPublicKey": record.recovery_public_key.as_ref().map(|key| STANDARD.encode(key)),
        }).to_string())
    }

    /// Restores this Windows device using an offline Android recovery kit. It registers a fresh
    /// Windows Hello credential and never restores an owner session or private application data.
    pub fn recover_with_android_kit(
        &mut self,
        window: &tauri::WebviewWindow,
        material: &str,
        passphrase: &str,
    ) -> Result<OwnerStatus, String> {
        use ring::signature::KeyPair as _;
        if self.device.is_some() {
            return Err(
                "This desktop is already enrolled. Use Windows Hello or lock it first.".into(),
            );
        }
        let recovery = open_recovery_kit(material, passphrase)?;
        #[cfg(windows)]
        let mut record = windows_auth::register_for_owner(window, &recovery.owner_id)?;
        #[cfg(not(windows))]
        let mut record: StoredOwnerDevice =
            return Err("Windows recovery enrollment is only available on Windows.".into());

        let mut engine = AuthorityEngine::new();
        engine
            .bootstrap_recovery_identity(
                OwnerId(recovery.owner_id.clone()),
                recovery.public_key.clone(),
            )
            .map_err(|error| format!("Recovery identity was rejected: {error:?}"))?;
        let challenge = engine
            .begin_device_recovery(
                DeviceId(record.device_id.clone()),
                DevicePlatform::Windows,
                record.public_key.clone(),
            )
            .map_err(|error| format!("Cannot create recovery challenge: {error:?}"))?;
        let rng = ring::rand::SystemRandom::new();
        let recovery_key = ring::signature::EcdsaKeyPair::from_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
            recovery.private_key_pkcs8.as_slice(),
            &rng,
        )
        .map_err(|_| {
            "The recovery kit private key is not a supported P-256 credential.".to_owned()
        })?;
        if recovery_key.public_key().as_ref() != recovery.public_key.as_slice() {
            return Err("The recovery kit private and public keys do not match.".into());
        }
        let proof = recovery_key
            .sign(&rng, &challenge.bytes)
            .map_err(|_| "Could not sign the recovery challenge.".to_owned())?;
        engine
            .complete_device_recovery(&challenge.challenge_id, proof.as_ref())
            .map_err(|error| format!("Recovery signature was rejected: {error:?}"))?;

        record.owner_id = recovery.owner_id;
        record.recovery_public_key = Some(recovery.public_key);
        record.trusted_devices.clear();
        let next_engine = engine_for_device(&record)?;
        self.persist_record(&record)?;
        self.engine = next_engine;
        self.device = Some(record);
        self.session_id = None;
        Ok(self.status())
    }

    fn persist_record(&self, record: &StoredOwnerDevice) -> Result<(), String> {
        let serialized = serde_json::to_vec(record)
            .map_err(|error| format!("Cannot encode owner enrollment: {error}"))?;
        let key = miss_minute_agent::secrets::get_or_create_file_key("owner-identity")
            .map_err(|error| format!("Cannot access the OS-protected owner key: {error:#}"))?;
        let sealed = crate::crypto::seal(&key, &serialized)?;
        let temporary = self
            .file
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Cannot create temporary owner enrollment: {error}"))?;
        if let Err(error) = file.write_all(&sealed).and_then(|_| file.sync_all()) {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("Cannot persist owner enrollment: {error}"));
        }
        drop(file);
        if let Err(error) = std::fs::rename(&temporary, &self.file) {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("Cannot commit owner enrollment: {error}"));
        }
        Ok(())
    }

    pub fn authenticate(&mut self, window: &tauri::WebviewWindow) -> Result<OwnerStatus, String> {
        let record = self
            .device
            .as_ref()
            .ok_or_else(|| "Set up the owner account on this desktop first.".to_owned())?;
        self.engine
            .observe_owner_candidate(miss_minute_identity::RecognitionSignal::Presence)
            .map_err(|e| format!("Owner authentication cannot start: {e:?}"))?;
        let challenge = self
            .engine
            .begin_authentication(&DeviceId(record.device_id.clone()))
            .map_err(|e| format!("Cannot issue a Windows Hello challenge: {e:?}"))?;
        #[cfg(windows)]
        let proof = match windows_auth::assertion(window, &record.credential_id, &challenge.bytes) {
            Ok(proof) => proof,
            Err(error) => {
                let _ = self.engine.cancel_authentication();
                return Err(error);
            }
        };
        #[cfg(not(windows))]
        let proof: Vec<u8> =
            return Err("Windows WebAuthn is unavailable on this desktop platform.".into());
        let verified = verify_authentication_proof(
            &mut self.engine,
            record,
            &challenge.bytes,
            &proof,
        )?;
        let session = self
            .engine
            .complete_owner_authentication_with_verified_proof(
                &challenge.challenge_id,
                verified,
                AuthenticationAssurance::PlatformUserVerification,
                Duration::from_secs(30 * 60),
            )
            .map_err(|e| format!("Windows Hello verification was rejected: {e:?}"))?;
        self.session_id = Some(session.session_id);
        Ok(self.status())
    }
}

/// A bad or malformed platform assertion must consume the pending auth attempt. Otherwise the
/// identity engine remains in AuthenticationPending and the next Windows Hello retry is rejected
/// as an invalid transition until the user explicitly locks or restarts Miss Minutes.
fn verify_authentication_proof(
    engine: &mut AuthorityEngine,
    record: &StoredOwnerDevice,
    challenge: &[u8],
    proof_json: &[u8],
) -> Result<miss_minute_identity::VerifiedPlatformProof, String> {
    match miss_minute_identity::verify_webauthn_assertion(
        &record.public_key,
        &record.credential_id,
        RP_ID,
        ORIGIN,
        challenge,
        proof_json,
    ) {
        Ok(proof) => Ok(proof),
        Err(error) => {
            let _ = engine.cancel_authentication();
            Err(format!("Windows Hello assertion was rejected: {error:?}"))
        }
    }
}

fn pairing_source_fingerprint(owner_id: &str, source_device_id: &str, source_key: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"miss-minutes-pair-source-fingerprint-v1\0");
    digest.update(owner_id.as_bytes());
    digest.update([0]);
    digest.update(source_device_id.as_bytes());
    digest.update([0]);
    digest.update(source_key);
    digest.finalize()[..10]
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>()
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).expect("hex is ASCII"))
        .collect::<Vec<_>>()
        .join("-")
}

fn open_recovery_kit(material: &str, passphrase: &str) -> Result<RecoveryCredential, String> {
    use ring::signature::KeyPair as _;
    const KIT_TYPE: &str = "miss-minutes-recovery-kit-v1";
    const ITERATIONS: u32 = 600_000;
    if material.len() > 32 * 1024
        || passphrase.len() < 12
        || passphrase.len() > 256
        || !passphrase.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
    {
        return Err("Recovery material must be valid JSON and the passphrase must be 12–256 printable ASCII characters.".into());
    }
    let kit: RecoveryKit = serde_json::from_str(material)
        .map_err(|error| format!("Recovery kit is invalid: {error}"))?;
    if kit.kind != KIT_TYPE
        || kit.version != 1
        || kit.iterations != ITERATIONS
        || kit.owner_id.len() < 16
        || kit.owner_id.len() > 64
        || !kit
            .owner_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err("Recovery kit version or identity is unsupported.".into());
    }
    let public_key = STANDARD
        .decode(&kit.public_key)
        .map_err(|_| "Recovery public key is not valid Base64.".to_owned())?;
    let salt = STANDARD
        .decode(&kit.salt)
        .map_err(|_| "Recovery salt is not valid Base64.".to_owned())?;
    let nonce = STANDARD
        .decode(&kit.nonce)
        .map_err(|_| "Recovery nonce is not valid Base64.".to_owned())?;
    let encrypted = STANDARD
        .decode(&kit.encrypted_private_key)
        .map_err(|_| "Encrypted recovery key is not valid Base64.".to_owned())?;
    if public_key.len() != 65
        || public_key[0] != 4
        || salt.len() != 16
        || nonce.len() != 12
        || !(64..=4096).contains(&encrypted.len())
    {
        return Err("Recovery kit contains a field with an invalid size.".into());
    }

    let aad = format!(
        "{KIT_TYPE}\n{}\n{}",
        kit.owner_id,
        STANDARD.encode(&public_key)
    );
    let mut derived = Zeroizing::new([0_u8; 32]);
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA256,
        std::num::NonZeroU32::new(ITERATIONS).expect("fixed non-zero iteration count"),
        &salt,
        passphrase.as_bytes(),
        &mut derived[..],
    );
    let plaintext = {
        let cipher = Aes256Gcm::new_from_slice(&derived[..])
            .map_err(|_| "Could not initialize recovery decryption.".to_owned())?;
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &encrypted,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| {
                "Recovery kit could not be decrypted; check the passphrase and kit.".to_owned()
            })?
    };
    let private_key_pkcs8 = Zeroizing::new(plaintext);
    let rng = ring::rand::SystemRandom::new();
    let key = ring::signature::EcdsaKeyPair::from_pkcs8(
        &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
        private_key_pkcs8.as_slice(),
        &rng,
    )
    .map_err(|_| "Recovery kit does not contain a supported P-256 private key.".to_owned())?;
    if key.public_key().as_ref() != public_key.as_slice() {
        return Err("Recovery kit private key does not match its public key.".into());
    }
    Ok(RecoveryCredential {
        owner_id: kit.owner_id,
        public_key,
        private_key_pkcs8,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequest {
    #[serde(rename = "type")]
    kind: String,
    device_id: String,
    platform: String,
    public_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryKit {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    owner_id: String,
    public_key: String,
    salt: String,
    nonce: String,
    iterations: u32,
    encrypted_private_key: String,
}

struct RecoveryCredential {
    owner_id: String,
    public_key: Vec<u8>,
    private_key_pkcs8: Zeroizing<Vec<u8>>,
}

fn engine_for_device(record: &StoredOwnerDevice) -> Result<AuthorityEngine, String> {
    if record.credential_id.is_empty() || record.credential_id.len() > 2048 {
        return Err("Windows WebAuthn credential ID is missing or too large.".into());
    }
    let mut engine = AuthorityEngine::new();
    engine
        .enroll_owner(
            OwnerId(record.owner_id.clone()),
            DeviceId(record.device_id.clone()),
            DeviceCredentialRegistration {
                platform: DevicePlatform::Windows,
                public_key: record.public_key.clone(),
            },
            OWNER_CAPABILITIES
                .iter()
                .map(|name| Capability::new(*name).expect("fixed capability")),
        )
        .map_err(|e| format!("Windows owner credential was rejected: {e:?}"))?;
    for device in &record.trusted_devices {
        if device.device_id == record.device_id {
            continue;
        }
        engine
            .restore_trusted_device(
                DeviceId(device.device_id.clone()),
                DeviceCredentialRegistration {
                    platform: device.platform,
                    public_key: device.public_key.clone(),
                },
            )
            .map_err(|error| {
                format!(
                    "Cannot restore paired device {}: {error:?}",
                    device.device_id
                )
            })?;
    }
    if let Some(key) = &record.recovery_public_key {
        engine
            .restore_recovery_public_key(key.clone())
            .map_err(|error| format!("Cannot restore recovery credential: {error:?}"))?;
    }
    Ok(engine)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(public_key: Vec<u8>) -> StoredOwnerDevice {
        StoredOwnerDevice {
            owner_id: "owner-1".into(),
            device_id: "device-1".into(),
            credential_id: vec![1, 2, 3],
            public_key,
            trusted_devices: Vec::new(),
            recovery_public_key: None,
        }
    }

    fn p256_generator() -> Vec<u8> {
        const HEX: &str = "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
        (0..HEX.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&HEX[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn engine_validation_rejects_bad_key_before_any_record_can_be_committed() {
        assert!(engine_for_device(&record(vec![4; 65])).is_err());
        assert!(engine_for_device(&record(p256_generator())).is_ok());
    }

    #[test]
    fn invalid_webauthn_assertion_cancels_attempt_and_allows_retry() {
        let record = record(p256_generator());
        let mut engine = engine_for_device(&record).unwrap();
        let device_id = DeviceId(record.device_id.clone());

        engine.observe_owner_candidate(miss_minute_identity::RecognitionSignal::Presence).unwrap();
        let challenge = engine.begin_authentication(&device_id).unwrap();
        let error = verify_authentication_proof(&mut engine, &record, &challenge.bytes, b"not-json")
            .unwrap_err();

        assert!(error.contains("Windows Hello assertion was rejected"));
        assert_eq!(engine.state(), miss_minute_identity::AuthState::Locked);
        engine.observe_owner_candidate(miss_minute_identity::RecognitionSignal::Presence).unwrap();
        assert!(engine.begin_authentication(&device_id).is_ok());
    }
}

#[cfg(windows)]
mod windows_auth {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::slice;
    use windows::{
        Win32::Networking::WindowsWebServices::*,
        core::{PCWSTR, w},
    };

    const HASH_NAME: windows::core::PCWSTR = w!("SHA-256");

    pub fn register(window: &tauri::WebviewWindow) -> Result<StoredOwnerDevice, String> {
        register_for_owner(window, &uuid::Uuid::new_v4().simple().to_string())
    }

    pub fn register_for_owner(
        window: &tauri::WebviewWindow,
        owner_id: &str,
    ) -> Result<StoredOwnerDevice, String> {
        if unsafe { WebAuthNGetApiVersionNumber() } < WEBAUTHN_API_VERSION_1 {
            return Err("Windows WebAuthn is not available on this system.".into());
        }
        if owner_id.len() < 16
            || owner_id.len() > 64
            || !owner_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        {
            return Err("Owner identity is not valid for Windows Hello.".into());
        }
        let owner_id = owner_id.to_owned();
        let device_id = uuid::Uuid::new_v4().simple().to_string();
        let challenge = crate::crypto::random_bytes(32)?;
        let client_data = client_data("webauthn.create", &challenge)?;
        let client = WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: client_data.len() as u32,
            pbClientDataJSON: client_data.as_ptr() as *mut u8,
            pwszHashAlgId: HASH_NAME,
        };
        let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
            dwVersion: 1,
            pwszId: w!("missminutes.local"),
            pwszName: w!("Miss Minutes"),
            pwszIcon: PCWSTR::null(),
        };
        let user_name: Vec<u16> = format!("owner-{owner_id}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let display_name: Vec<u16> = "Miss Minutes owner".encode_utf16().chain(Some(0)).collect();
        let mut user_id = owner_id.as_bytes().to_vec();
        let user = WEBAUTHN_USER_ENTITY_INFORMATION {
            dwVersion: 1,
            cbId: user_id.len() as u32,
            pbId: user_id.as_mut_ptr(),
            pwszName: PCWSTR(user_name.as_ptr()),
            pwszIcon: PCWSTR::null(),
            pwszDisplayName: PCWSTR(display_name.as_ptr()),
        };
        let mut parameter = WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
            dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
            pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
            lAlg: WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256,
        };
        let parameters = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
            cCredentialParameters: 1,
            pCredentialParameters: &mut parameter,
        };
        let mut options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS::default();
        options.dwVersion = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_1;
        options.dwTimeoutMilliseconds = 120_000;
        options.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM;
        options.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
        options.dwAttestationConveyancePreference = WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE;
        let hwnd = window
            .hwnd()
            .map_err(|e| format!("Cannot open Windows Hello: {e}"))?;
        let attestation = unsafe {
            WebAuthNAuthenticatorMakeCredential(
                hwnd,
                &rp,
                &user,
                &parameters,
                &client,
                Some(&options),
            )
        }
        .map_err(|e| format!("Windows Hello enrollment failed: {e}"))?;
        let result = unsafe {
            (|| -> Result<StoredOwnerDevice, String> {
                if attestation.is_null() {
                    return Err("Windows WebAuthn returned no credential.".into());
                }
                let item = &*attestation;
                if item.cbCredentialId == 0
                    || item.cbCredentialId > 2048
                    || item.cbAuthenticatorData > 16_384
                    || item.pbCredentialId.is_null()
                    || item.pbAuthenticatorData.is_null()
                {
                    Err("Windows WebAuthn returned an invalid credential.".into())
                } else {
                    let credential_id =
                        slice::from_raw_parts(item.pbCredentialId, item.cbCredentialId as usize)
                            .to_vec();
                    let auth_data = slice::from_raw_parts(
                        item.pbAuthenticatorData,
                        item.cbAuthenticatorData as usize,
                    );
                    let (auth_credential_id, public_key) = extract_credential(auth_data)?;
                    if auth_credential_id != credential_id {
                        Err(
                            "Windows WebAuthn credential data did not match its attestation."
                                .into(),
                        )
                    } else {
                        Ok(StoredOwnerDevice {
                            owner_id,
                            device_id,
                            credential_id,
                            public_key,
                            trusted_devices: Vec::new(),
                            recovery_public_key: None,
                        })
                    }
                }
            })()
        };
        if !attestation.is_null() {
            unsafe {
                WebAuthNFreeCredentialAttestation(Some(attestation));
            }
        }
        result
    }

    pub fn assertion(
        window: &tauri::WebviewWindow,
        credential_id: &[u8],
        challenge: &[u8],
    ) -> Result<Vec<u8>, String> {
        let client_data = client_data("webauthn.get", challenge)?;
        let client = WEBAUTHN_CLIENT_DATA {
            dwVersion: 1,
            cbClientDataJSON: client_data.len() as u32,
            pbClientDataJSON: client_data.as_ptr() as *mut u8,
            pwszHashAlgId: HASH_NAME,
        };
        let mut allowed = WEBAUTHN_CREDENTIAL {
            dwVersion: 1,
            cbId: credential_id.len() as u32,
            pbId: credential_id.as_ptr() as *mut u8,
            pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
        };
        let list = WEBAUTHN_CREDENTIALS {
            cCredentials: 1,
            pCredentials: &mut allowed,
        };
        let mut options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS::default();
        options.dwVersion = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_1;
        options.dwTimeoutMilliseconds = 120_000;
        options.CredentialList = list;
        options.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM;
        options.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
        let hwnd = window
            .hwnd()
            .map_err(|e| format!("Cannot open Windows Hello: {e}"))?;
        let assertion = unsafe {
            WebAuthNAuthenticatorGetAssertion(
                hwnd,
                w!("missminutes.local"),
                &client,
                Some(&options),
            )
        }
        .map_err(|e| format!("Windows Hello authentication failed: {e}"))?;
        let result = unsafe {
            (|| -> Result<Vec<u8>, String> {
                if assertion.is_null() {
                    return Err("Windows WebAuthn returned no assertion.".into());
                }
                let item = &*assertion;
                if item.cbAuthenticatorData > 16_384
                    || item.cbSignature > 4096
                    || item.Credential.cbId > 2048
                    || item.pbAuthenticatorData.is_null()
                    || item.pbSignature.is_null()
                    || item.Credential.pbId.is_null()
                {
                    Err("Windows WebAuthn returned an invalid assertion.".into())
                } else {
                    let proof = serde_json::json!({
                        "credentialId": URL_SAFE_NO_PAD.encode(slice::from_raw_parts(item.Credential.pbId, item.Credential.cbId as usize)),
                        "authenticatorData": URL_SAFE_NO_PAD.encode(slice::from_raw_parts(item.pbAuthenticatorData, item.cbAuthenticatorData as usize)),
                        "signature": URL_SAFE_NO_PAD.encode(slice::from_raw_parts(item.pbSignature, item.cbSignature as usize)),
                        "clientDataJson": URL_SAFE_NO_PAD.encode(&client_data),
                    });
                    serde_json::to_vec(&proof)
                        .map_err(|e| format!("Cannot encode Windows assertion: {e}"))
                }
            })()
        };
        if !assertion.is_null() {
            unsafe {
                WebAuthNFreeAssertion(assertion);
            }
        }
        result
    }

    fn client_data(kind: &str, challenge: &[u8]) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&serde_json::json!({ "type": kind, "challenge": URL_SAFE_NO_PAD.encode(challenge), "origin": ORIGIN, "crossOrigin": false }))
            .map_err(|e| format!("Cannot encode WebAuthn client data: {e}"))
    }

    fn extract_credential(auth_data: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
        if auth_data.len() < 55 || auth_data.len() > 16_384 {
            return Err("Authenticator data has an invalid size.".into());
        }
        if auth_data[..32] != Sha256::digest(RP_ID.as_bytes())[..] || auth_data[32] & 0x45 != 0x45 {
            return Err(
                "Windows Hello did not provide verified user presence and registration data."
                    .into(),
            );
        }
        let id_len = u16::from_be_bytes([auth_data[53], auth_data[54]]) as usize;
        if id_len == 0 || id_len > 2048 || auth_data.len() < 55 + id_len {
            return Err("Attested credential ID is invalid.".into());
        }
        let id = auth_data[55..55 + id_len].to_vec();
        let cose = &auth_data[55 + id_len..];
        let (x, y) = cose_p256_coordinates(cose)?;
        let mut public_key = Vec::with_capacity(65);
        public_key.push(0x04);
        public_key.extend_from_slice(&x);
        public_key.extend_from_slice(&y);
        Ok((id, public_key))
    }

    fn cbor_head(bytes: &[u8], pos: &mut usize) -> Result<(u8, u64), String> {
        let first = *bytes.get(*pos).ok_or("Truncated COSE public key")?;
        *pos += 1;
        let major = first >> 5;
        let add = first & 31;
        let value = match add {
            n @ 0..=23 => n as u64,
            24 => {
                let x = *bytes.get(*pos).ok_or("Truncated CBOR")? as u64;
                *pos += 1;
                x
            }
            25 => {
                let s = bytes.get(*pos..*pos + 2).ok_or("Truncated CBOR")?;
                *pos += 2;
                u16::from_be_bytes([s[0], s[1]]) as u64
            }
            26 => {
                let s = bytes.get(*pos..*pos + 4).ok_or("Truncated CBOR")?;
                *pos += 4;
                u32::from_be_bytes(s.try_into().map_err(|_| "Truncated CBOR")?) as u64
            }
            27 => {
                let s = bytes.get(*pos..*pos + 8).ok_or("Truncated CBOR")?;
                *pos += 8;
                u64::from_be_bytes(s.try_into().map_err(|_| "Truncated CBOR")?)
            }
            _ => return Err("Indefinite CBOR is not accepted in the credential key.".into()),
        };
        Ok((major, value))
    }
    fn cbor_integer(bytes: &[u8], pos: &mut usize) -> Result<i64, String> {
        let (major, value) = cbor_head(bytes, pos)?;
        match major {
            0 => i64::try_from(value).map_err(|_| "COSE integer overflow".into()),
            1 => i64::try_from(value)
                .map(|n| -1 - n)
                .map_err(|_| "COSE integer overflow".into()),
            _ => Err("COSE key is not an integer.".into()),
        }
    }
    fn cbor_skip(bytes: &[u8], pos: &mut usize, depth: usize) -> Result<(), String> {
        if depth > 8 {
            return Err("COSE key nesting is too deep.".into());
        }
        let (major, count) = cbor_head(bytes, pos)?;
        match major {
            0 | 1 | 7 => Ok(()),
            2 | 3 => {
                let n = usize::try_from(count).map_err(|_| "CBOR item too large")?;
                *pos = pos
                    .checked_add(n)
                    .filter(|end| *end <= bytes.len())
                    .ok_or("Truncated CBOR")?;
                Ok(())
            }
            4 => {
                for _ in 0..count {
                    cbor_skip(bytes, pos, depth + 1)?;
                }
                Ok(())
            }
            5 => {
                for _ in 0..count {
                    cbor_skip(bytes, pos, depth + 1)?;
                    cbor_skip(bytes, pos, depth + 1)?;
                }
                Ok(())
            }
            6 => cbor_skip(bytes, pos, depth + 1),
            _ => Err("Unsupported CBOR value.".into()),
        }
    }
    fn cbor_bytes(bytes: &[u8], pos: &mut usize) -> Result<Vec<u8>, String> {
        let (major, len) = cbor_head(bytes, pos)?;
        if major != 2 {
            return Err("COSE coordinate is not a byte string.".into());
        }
        let len = usize::try_from(len).map_err(|_| "Coordinate too large")?;
        let end = pos
            .checked_add(len)
            .filter(|end| *end <= bytes.len())
            .ok_or("Truncated coordinate")?;
        let value = bytes[*pos..end].to_vec();
        *pos = end;
        Ok(value)
    }
    fn cose_p256_coordinates(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
        let mut pos = 0;
        let (major, count) = cbor_head(bytes, &mut pos)?;
        if major != 5 || count > 16 {
            return Err("COSE public key is not a bounded map.".into());
        }
        let mut kty = None;
        let mut alg = None;
        let mut crv = None;
        let mut x = None;
        let mut y = None;
        for _ in 0..count {
            let key = cbor_integer(bytes, &mut pos)?;
            match key {
                1 => kty = Some(cbor_integer(bytes, &mut pos)?),
                3 => alg = Some(cbor_integer(bytes, &mut pos)?),
                -1 => crv = Some(cbor_integer(bytes, &mut pos)?),
                -2 => x = Some(cbor_bytes(bytes, &mut pos)?),
                -3 => y = Some(cbor_bytes(bytes, &mut pos)?),
                _ => cbor_skip(bytes, &mut pos, 0)?,
            }
        }
        if kty != Some(2) || alg != Some(-7) || crv != Some(1) {
            return Err("Only COSE ES256 P-256 credentials are accepted.".into());
        }
        let x = x.ok_or("Missing P-256 X coordinate")?;
        let y = y.ok_or("Missing P-256 Y coordinate")?;
        if x.len() != 32 || y.len() != 32 {
            return Err("Invalid P-256 coordinates.".into());
        }
        Ok((x, y))
    }
}
