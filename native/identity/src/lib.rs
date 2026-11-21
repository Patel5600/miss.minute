//! Shared, platform-neutral identity and authorization rules for Miss Minutes.
//!
//! This crate deliberately does not implement face recognition, speaker verification, OS
//! authentication or key storage. It provides a bounded device-pairing protocol; platform
//! adapters must store the resulting registry securely and verify source-device user
//! verification through an opaque proof before a new device is trusted.
//! Face, voice and presence observations can only prepare an owner candidate.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    num::NonZeroU32,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::Zeroizing;

pub mod attestation;
mod jni_bridge;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OwnerId(pub String);

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId(pub String);

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Capability(pub String);

impl Capability {
    pub fn new(value: impl Into<String>) -> Result<Self, AuthorityError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(AuthorityError::InvalidCapability);
        }
        Ok(Self(value))
    }
}

pub mod capabilities {
    use super::Capability;

    pub const GENERAL_CONVERSATION: &str = "conversation.general";
    pub const PUBLIC_INFORMATION: &str = "information.public";
    pub const HARMLESS_TASK: &str = "task.harmless";
    pub const PRIVATE_MEMORY_READ: &str = "memory.private.read";
    pub const PRIVATE_MEMORY_WRITE: &str = "memory.private.write";
    pub const PRIVATE_FILES_READ: &str = "files.private.read";
    pub const SETTINGS_MODIFY: &str = "settings.modify";
    pub const AI_PROVIDER_USE: &str = "ai.provider.use";
    pub const DEVICE_CONTROL: &str = "device.control";
    pub const OWNER_PROFILE_MODIFY: &str = "owner.profile.modify";

    pub fn guest_allowlist() -> [Capability; 3] {
        [
            Capability(GENERAL_CONVERSATION.into()),
            Capability(PUBLIC_INFORMATION.into()),
            Capability(HARMLESS_TASK.into()),
        ]
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    Owner,
    Guest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperatingMode {
    OwnerMode,
    OwnerCandidate,
    GuestMode,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    #[default]
    Unenrolled,
    Locked,
    OwnerCandidate,
    AuthenticationPending,
    OwnerAuthenticated,
    StepUpRequired,
    GuestActive,
    Revoked,
    DeviceUntrusted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecognitionSignal {
    FaceMatch,
    VoiceMatch,
    Presence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationAssurance {
    PlatformUserVerification,
    HardwareBackedPlatformUserVerification,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DevicePlatform {
    Android,
    Windows,
    Linux,
}

/// Public credential material registered for one device. Enrollment must verify that it came
/// from the platform's protected credential store; this crate never accepts a private key.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DeviceCredentialRegistration {
    pub platform: DevicePlatform,
    pub public_key: Vec<u8>,
}

/// Opaque, challenge-bound proof. Its private fields prevent downstream crates from
/// manufacturing platform-authentication success.
pub struct VerifiedPlatformProof {
    challenge: Vec<u8>,
    public_key: Vec<u8>,
}

impl std::fmt::Debug for VerifiedPlatformProof {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifiedPlatformProof")
            .finish_non_exhaustive()
    }
}

/// Verify a Windows WebAuthn assertion and return an opaque proof tied to the enrolled
/// credential and exact one-use Rust challenge. This does not create a session by itself.
pub fn verify_webauthn_assertion(
    public_key: &[u8],
    expected_credential_id: &[u8],
    rp_id: &str,
    expected_origin: &str,
    challenge: &[u8],
    proof_json: &[u8],
) -> Result<VerifiedPlatformProof, AuthorityError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Proof {
        credential_id: String,
        authenticator_data: String,
        signature: String,
        client_data_json: String,
    }
    #[derive(serde::Deserialize)]
    struct ClientData {
        r#type: String,
        challenge: String,
        origin: String,
        #[serde(default)]
        cross_origin: bool,
    }

    if public_key.len() != 65
        || public_key[0] != 0x04
        || expected_credential_id.is_empty()
        || expected_credential_id.len() > 2048
        || rp_id.is_empty()
        || expected_origin.is_empty()
        || challenge.is_empty()
        || challenge.len() > 4096
        || proof_json.len() > 64 * 1024
    {
        return Err(AuthorityError::InvalidSignature);
    }
    let proof: Proof =
        serde_json::from_slice(proof_json).map_err(|_| AuthorityError::InvalidSignature)?;
    let decode = |text: String, max: usize| -> Result<Vec<u8>, AuthorityError> {
        let value = URL_SAFE_NO_PAD
            .decode(text)
            .map_err(|_| AuthorityError::InvalidSignature)?;
        if value.is_empty() || value.len() > max {
            return Err(AuthorityError::InvalidSignature);
        }
        Ok(value)
    };
    let credential_id = decode(proof.credential_id, 2048)?;
    let authenticator_data = decode(proof.authenticator_data, 16 * 1024)?;
    let signature = decode(proof.signature, 4096)?;
    let client_data_json = decode(proof.client_data_json, 4096)?;
    if credential_id != expected_credential_id
        || authenticator_data.len() < 37
        || authenticator_data[..32] != Sha256::digest(rp_id.as_bytes())[..]
        || authenticator_data[32] & 0x05 != 0x05
    {
        return Err(AuthorityError::InvalidSignature);
    }
    let client: ClientData =
        serde_json::from_slice(&client_data_json).map_err(|_| AuthorityError::InvalidSignature)?;
    if client.r#type != "webauthn.get"
        || client.challenge != URL_SAFE_NO_PAD.encode(challenge)
        || client.origin != expected_origin
        || client.cross_origin
    {
        return Err(AuthorityError::InvalidSignature);
    }
    let mut signed = authenticator_data;
    signed
        .extend_from_slice(ring::digest::digest(&ring::digest::SHA256, &client_data_json).as_ref());
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_ASN1, public_key)
        .verify(&signed, &signature)
        .map_err(|_| AuthorityError::InvalidSignature)?;
    Ok(VerifiedPlatformProof {
        challenge: challenge.to_vec(),
        public_key: public_key.to_vec(),
    })
}

/// Verify an authentication-gated platform key signature over an exact one-use challenge.
/// Android adapters must obtain this signature through BiometricPrompt.CryptoObject using a
/// per-use Keystore key; raw signatures supplied by a renderer are never trusted directly.
pub fn verify_platform_signature(
    public_key: &[u8],
    challenge: &[u8],
    signature: &[u8],
) -> Result<VerifiedPlatformProof, AuthorityError> {
    if public_key.len() != 65
        || public_key[0] != 0x04
        || challenge.is_empty()
        || challenge.len() > 4096
        || signature.is_empty()
        || signature.len() > 4096
    {
        return Err(AuthorityError::InvalidSignature);
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_ASN1, public_key)
        .verify(challenge, signature)
        .map_err(|_| AuthorityError::InvalidSignature)?;
    Ok(VerifiedPlatformProof {
        challenge: challenge.to_vec(),
        public_key: public_key.to_vec(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticationChallenge {
    pub challenge_id: String,
    pub device_id: DeviceId,
    /// Domain-separated bytes that the platform credential must sign.
    pub bytes: Vec<u8>,
    pub expires_at: Instant,
}

/// Pairing request created by an untrusted target device and approved by a trusted source.
/// The signed bytes bind both device IDs, platform, target public key, owner ID and nonce.
#[derive(Clone, Debug)]
pub struct DevicePairingChallenge {
    pub challenge_id: String,
    pub owner_id: OwnerId,
    pub source_device_id: DeviceId,
    pub target_device_id: DeviceId,
    pub target_platform: DevicePlatform,
    pub target_public_key: Vec<u8>,
    /// Random one-use nonce included in `bytes` and serialized to the offline receipt.
    pub nonce: Vec<u8>,
    pub bytes: Vec<u8>,
    pub expires_at: Instant,
}

/// An offline recovery-key challenge to add a replacement trusted device.
#[derive(Clone, Debug)]
pub struct DeviceRecoveryChallenge {
    pub challenge_id: String,
    pub owner_id: OwnerId,
    pub target_device_id: DeviceId,
    pub target_platform: DevicePlatform,
    pub target_public_key: Vec<u8>,
    pub bytes: Vec<u8>,
    pub expires_at: Instant,
}

#[derive(Clone, Debug)]
struct PendingChallenge {
    challenge: AuthenticationChallenge,
    prior_state: AuthState,
}

#[derive(Clone, Debug)]
struct PendingPairing {
    challenge: DevicePairingChallenge,
    owner_session_id: String,
}

#[derive(Clone, Debug)]
struct PendingRecovery {
    challenge: DeviceRecoveryChallenge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandOrigin {
    UserInput,
    VoiceInput,
    Model,
    Plugin,
    ExternalContent,
    Notification,
    System,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Low,
    Elevated,
    High,
    Critical,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CommandRequest {
    pub origin: CommandOrigin,
    pub capability: Capability,
    pub target: String,
    pub risk: Risk,
    pub requires_confirmation: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizationDecision {
    Allow,
    Deny,
    ConfirmationRequired,
    FreshAuthenticationRequired,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AuthorizationResult {
    pub decision: AuthorizationDecision,
    pub reason: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthorityError {
    AlreadyEnrolled,
    NotEnrolled,
    InvalidTransition,
    UnknownDevice,
    DeviceRevoked,
    InvalidSessionLifetime,
    InvalidCapability,
    InvalidCredential,
    InvalidIdentity,
    InvalidChallenge,
    InvalidSignature,
    PairingAlreadyPending,
    TooManyDevices,
    RecoveryLocked,
    SnapshotCorrupted,
}

#[allow(dead_code)] // Used by the crate-private platform authentication path, pending adapters.
const MAX_OWNER_SESSION_LIFETIME: Duration = Duration::from_secs(30 * 60);
pub const OWNER_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_GUEST_SESSION_LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);
const STEP_UP_WINDOW: Duration = Duration::from_secs(30);
const MAX_TRUSTED_DEVICES: usize = 16;
const DEVICE_PAIRING_TTL: Duration = Duration::from_secs(120);
pub const MIN_CANDIDATE_CONFIDENCE: f32 = 0.70;
const MAX_AUDIT_ENTRIES: usize = 256;

#[derive(Clone, Debug, Default)]
struct CandidateSignals {
    face_confidence: Option<f32>,
    voice_confidence: Option<f32>,
    gaze_engaged: bool,
}

const AUDIT_GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const SNAPSHOT_MAGIC: &[u8; 9] = b"MMIDSNAP1";
const MAX_RECOVERY_ATTEMPTS: u8 = 3;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AuditEntry {
    pub sequence: u64,
    pub event: String,
    pub from_state: AuthState,
    pub to_state: AuthState,
    pub mode: OperatingMode,
    pub detail: String,
    pub prev_hash: String,
    pub entry_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RecoveryCodeEntry {
    hash: [u8; 32],
    used: bool,
}

#[derive(Clone, Debug)]
pub struct OwnerSession {
    pub owner_id: OwnerId,
    pub device_id: DeviceId,
    pub session_id: String,
    pub issued_at: Instant,
    pub expires_at: Instant,
    pub last_owner_activity: Instant,
    pub capabilities: HashSet<Capability>,
    pub assurance: AuthenticationAssurance,
    revoked: bool,
}

#[derive(Clone, Debug)]
pub struct GuestSession {
    pub session_id: String,
    pub issued_at: Instant,
    pub expires_at: Instant,
    capabilities: HashSet<Capability>,
}

#[derive(Clone, Debug)]
pub enum Session {
    Owner(OwnerSession),
    Guest(GuestSession),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TrustedDevice {
    revoked: bool,
    #[allow(dead_code)] // Read by the crate-private session activation path.
    credential: DeviceCredentialRegistration,
}

/// In-memory policy and session authority. Persist enrollment and device public keys through a
/// platform-protected registry; never serialize the live session or monotonic timestamps.
#[derive(Debug)]
pub struct AuthorityEngine {
    base_instant: Instant,
    owner_id: Option<OwnerId>,
    state: AuthState,
    devices: HashMap<DeviceId, TrustedDevice>,
    pending_challenge: Option<PendingChallenge>,
    pending_pairing: Option<PendingPairing>,
    pending_recovery: Option<PendingRecovery>,
    recovery_public_key: Option<Vec<u8>>,
    recovery_code_hashes: Vec<RecoveryCodeEntry>,
    failed_recovery_attempts: u8,
    recovery_locked: bool,
    owner_capabilities: HashSet<Capability>,
    sessions: HashMap<String, Session>,
    candidate_signals: CandidateSignals,
    audit_seq: u64,
    audit_entries: VecDeque<AuditEntry>,
}

impl Default for AuthorityEngine {
    fn default() -> Self {
        Self {
            base_instant: Instant::now(),
            owner_id: None,
            state: AuthState::default(),
            devices: HashMap::new(),
            pending_challenge: None,
            pending_pairing: None,
            pending_recovery: None,
            recovery_public_key: None,
            recovery_code_hashes: Vec::new(),
            failed_recovery_attempts: 0,
            recovery_locked: false,
            owner_capabilities: HashSet::new(),
            sessions: HashMap::new(),
            candidate_signals: CandidateSignals::default(),
            audit_seq: 0,
            audit_entries: VecDeque::new(),
        }
    }
}

impl AuthorityEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn base_instant(&self) -> Instant {
        self.base_instant
    }

    pub fn instant_at_ms(&self, offset_ms: u64) -> Instant {
        self.base_instant
            .checked_add(Duration::from_millis(offset_ms))
            .unwrap_or(self.base_instant)
    }

    pub fn state(&self) -> AuthState {
        self.state
    }
    pub fn owner_id(&self) -> Option<&OwnerId> {
        self.owner_id.as_ref()
    }

    pub fn operating_mode(&self, now: Instant) -> OperatingMode {
        match self.state {
            AuthState::OwnerAuthenticated => {
                let active = self.sessions.iter().any(|(id, session)| {
                    matches!(session, Session::Owner(_)) && self.owner_session_active(id, now)
                });
                if active {
                    OperatingMode::OwnerMode
                } else {
                    OperatingMode::GuestMode
                }
            }
            AuthState::OwnerCandidate => OperatingMode::OwnerCandidate,
            _ => OperatingMode::GuestMode,
        }
    }

    pub fn candidate_confidence(&self) -> f32 {
        let face = self.candidate_signals.face_confidence.unwrap_or(0.0);
        let voice = self.candidate_signals.voice_confidence.unwrap_or(0.0);
        let gaze = if self.candidate_signals.gaze_engaged {
            1.0
        } else {
            0.0
        };
        (0.55 * face + 0.35 * voice + 0.10 * gaze).clamp(0.0, 1.0)
    }

    pub fn audit_log(&self) -> Vec<AuditEntry> {
        self.audit_entries.iter().cloned().collect()
    }

    pub fn verify_audit_chain(&self) -> bool {
        let mut expected_prev: Option<&str> = None;
        for entry in &self.audit_entries {
            if entry.sequence == 1 && entry.prev_hash != AUDIT_GENESIS_HASH {
                return false;
            }
            if let Some(prev) = expected_prev
                && entry.prev_hash != prev
            {
                return false;
            }
            let recomputed = compute_audit_entry_hash(
                entry.sequence,
                &entry.prev_hash,
                &entry.event,
                entry.from_state,
                entry.to_state,
                entry.mode,
                &entry.detail,
            );
            if entry.entry_hash != recomputed {
                return false;
            }
            expected_prev = Some(entry.entry_hash.as_str());
        }
        true
    }

    pub fn is_recovery_locked(&self) -> bool {
        self.recovery_locked
    }

    pub fn failed_recovery_attempts(&self) -> u8 {
        self.failed_recovery_attempts
    }

    /// Emergency kill switch: revokes all active owner & guest sessions, wipes pending challenges,
    /// clears candidate biometric confidence cues, transitions to Locked/Unenrolled, and logs
    /// an integrity-chained kill entry.
    pub fn emergency_kill(&mut self) {
        let from_state = self.state;
        self.pending_challenge = None;
        self.pending_pairing = None;
        self.pending_recovery = None;
        self.candidate_signals = CandidateSignals::default();
        self.sessions.retain(|_, session| match session {
            Session::Owner(s) => {
                s.revoked = true;
                false
            }
            Session::Guest(_) => false,
        });
        self.state = if self.owner_id.is_some() {
            AuthState::Locked
        } else {
            AuthState::Unenrolled
        };
        self.record_audit(
            "emergency_kill",
            from_state,
            self.state,
            "all_sessions_wiped",
        );
    }

    fn record_audit(
        &mut self,
        event: impl Into<String>,
        from_state: AuthState,
        to_state: AuthState,
        detail: impl Into<String>,
    ) {
        self.audit_seq = self.audit_seq.saturating_add(1);
        let prev_hash = self
            .audit_entries
            .back()
            .map(|e| e.entry_hash.clone())
            .unwrap_or_else(|| AUDIT_GENESIS_HASH.to_owned());
        if self.audit_entries.len() >= MAX_AUDIT_ENTRIES {
            self.audit_entries.pop_front();
        }
        let mode = match to_state {
            AuthState::OwnerAuthenticated => OperatingMode::OwnerMode,
            AuthState::OwnerCandidate => OperatingMode::OwnerCandidate,
            _ => OperatingMode::GuestMode,
        };
        let event = event.into();
        let detail = redact_audit_detail(&detail.into());
        let entry_hash = compute_audit_entry_hash(
            self.audit_seq,
            &prev_hash,
            &event,
            from_state,
            to_state,
            mode,
            &detail,
        );
        self.audit_entries.push_back(AuditEntry {
            sequence: self.audit_seq,
            event,
            from_state,
            to_state,
            mode,
            detail,
            prev_hash,
            entry_hash,
        });
    }

    /// Enrollment is explicit and one-time. Enrollment of a real device/key is platform work.
    pub fn enroll_owner(
        &mut self,
        owner_id: OwnerId,
        trusted_device: DeviceId,
        credential: DeviceCredentialRegistration,
        owner_capabilities: impl IntoIterator<Item = Capability>,
    ) -> Result<(), AuthorityError> {
        if self.owner_id.is_some() {
            return Err(AuthorityError::AlreadyEnrolled);
        }
        if !valid_identifier(&owner_id.0) || !valid_identifier(&trusted_device.0) {
            return Err(AuthorityError::InvalidIdentity);
        }
        validate_public_key(&credential.public_key)?;
        let mut capabilities = HashSet::new();
        for capability in owner_capabilities {
            capabilities.insert(Capability::new(capability.0)?);
        }
        let from_state = self.state;
        self.owner_id = Some(owner_id);
        self.devices.insert(
            trusted_device,
            TrustedDevice {
                revoked: false,
                credential,
            },
        );
        self.owner_capabilities = capabilities;
        self.state = AuthState::Locked;
        self.record_audit("enroll_owner", from_state, self.state, "enrolled");
        Ok(())
    }

    /// Installs or rotates the offline recovery public key after a recent, live owner
    /// authentication. Its private key is generated/exported by the platform adapter and must
    /// remain in the owner's offline recovery material, never in this registry.
    pub fn set_recovery_public_key(
        &mut self,
        owner_session_id: &str,
        public_key: Vec<u8>,
        now: Instant,
    ) -> Result<(), AuthorityError> {
        validate_public_key(&public_key)?;
        let Some(Session::Owner(session)) = self.sessions.get(owner_session_id) else {
            return Err(AuthorityError::InvalidTransition);
        };
        if session.revoked
            || now >= session.expires_at
            || now.saturating_duration_since(session.issued_at) > STEP_UP_WINDOW
            || !session
                .capabilities
                .contains(&Capability(capabilities::OWNER_PROFILE_MODIFY.into()))
        {
            return Err(AuthorityError::InvalidTransition);
        }
        self.recovery_public_key = Some(public_key);
        self.pending_recovery = None;
        Ok(())
    }

    /// Restores an additional public credential from the platform's authenticated, protected
    /// registry. Never expose this as a renderer or network operation.
    pub fn restore_trusted_device(
        &mut self,
        device_id: DeviceId,
        credential: DeviceCredentialRegistration,
    ) -> Result<(), AuthorityError> {
        if self.owner_id.is_none() {
            return Err(AuthorityError::NotEnrolled);
        }
        if self.devices.len() >= MAX_TRUSTED_DEVICES {
            return Err(AuthorityError::TooManyDevices);
        }
        if !valid_identifier(&device_id.0) || self.devices.contains_key(&device_id) {
            return Err(AuthorityError::InvalidIdentity);
        }
        validate_public_key(&credential.public_key)?;
        self.devices.insert(
            device_id,
            TrustedDevice {
                revoked: false,
                credential,
            },
        );
        Ok(())
    }

    /// Restores a device credential from the protected platform registry while preserving its
    /// persisted revocation state. Callers must never restore a revoked entry as trusted.
    pub fn restore_revoked_device(
        &mut self,
        device_id: DeviceId,
        credential: DeviceCredentialRegistration,
    ) -> Result<(), AuthorityError> {
        self.restore_trusted_device(device_id.clone(), credential)?;
        self.revoke_device(&device_id)
    }

    /// Restores a recovery verifier from the platform's integrity-protected owner registry.
    pub fn restore_recovery_public_key(
        &mut self,
        public_key: Vec<u8>,
    ) -> Result<(), AuthorityError> {
        if self.owner_id.is_none() {
            return Err(AuthorityError::NotEnrolled);
        }
        validate_public_key(&public_key)?;
        self.recovery_public_key = Some(public_key);
        Ok(())
    }

    /// Starts recovery on a clean installation using the owner ID and public recovery key from
    /// the offline recovery material. This creates no device trust or session; only a valid,
    /// one-use recovery signature can register the replacement device.
    pub fn bootstrap_recovery_identity(
        &mut self,
        owner_id: OwnerId,
        recovery_public_key: Vec<u8>,
    ) -> Result<(), AuthorityError> {
        if self.owner_id.is_some()
            || !self.devices.is_empty()
            || !self.sessions.is_empty()
            || self.state != AuthState::Unenrolled
        {
            return Err(AuthorityError::AlreadyEnrolled);
        }
        if !valid_identifier(&owner_id.0) {
            return Err(AuthorityError::InvalidIdentity);
        }
        validate_public_key(&recovery_public_key)?;
        self.owner_id = Some(owner_id);
        self.recovery_public_key = Some(recovery_public_key);
        self.state = AuthState::Locked;
        Ok(())
    }

    /// Creates a short-lived one-use replacement-device challenge. It grants no authority by
    /// itself; the offline recovery private key must sign the exact bound bytes to commit.
    pub fn begin_device_recovery(
        &mut self,
        target_device_id: DeviceId,
        target_platform: DevicePlatform,
        target_public_key: Vec<u8>,
    ) -> Result<DeviceRecoveryChallenge, AuthorityError> {
        if self.pending_recovery.is_some() || self.pending_pairing.is_some() {
            return Err(AuthorityError::PairingAlreadyPending);
        }
        if self.recovery_public_key.is_none() {
            return Err(AuthorityError::InvalidCredential);
        }
        if self.devices.len() >= MAX_TRUSTED_DEVICES {
            return Err(AuthorityError::TooManyDevices);
        }
        if !valid_identifier(&target_device_id.0) || self.devices.contains_key(&target_device_id) {
            return Err(AuthorityError::InvalidIdentity);
        }
        validate_public_key(&target_public_key)?;
        let owner_id = self.owner_id.clone().ok_or(AuthorityError::NotEnrolled)?;
        let challenge_id = Uuid::new_v4().to_string();
        let mut nonce = Vec::with_capacity(32);
        nonce.extend_from_slice(Uuid::new_v4().as_bytes());
        nonce.extend_from_slice(Uuid::new_v4().as_bytes());
        let mut bytes = b"miss-minutes-device-recovery-v1\0".to_vec();
        append_field(&mut bytes, owner_id.0.as_bytes());
        append_field(&mut bytes, target_device_id.0.as_bytes());
        append_field(&mut bytes, device_platform_name(target_platform).as_bytes());
        append_field(&mut bytes, &target_public_key);
        append_field(&mut bytes, challenge_id.as_bytes());
        append_field(&mut bytes, &nonce);
        let challenge = DeviceRecoveryChallenge {
            challenge_id,
            owner_id,
            target_device_id,
            target_platform,
            target_public_key,
            bytes,
            expires_at: Instant::now()
                .checked_add(DEVICE_PAIRING_TTL)
                .ok_or(AuthorityError::InvalidSessionLifetime)?,
        };
        self.pending_recovery = Some(PendingRecovery {
            challenge: challenge.clone(),
        });
        Ok(challenge)
    }

    /// Commits a replacement device only after verifying the offline recovery signature.
    /// Attempts are one-use; invalid signatures consume the pending challenge.
    pub fn complete_device_recovery(
        &mut self,
        challenge_id: &str,
        signature: &[u8],
    ) -> Result<DeviceId, AuthorityError> {
        let pending = self
            .pending_recovery
            .take()
            .ok_or(AuthorityError::InvalidChallenge)?;
        let challenge = pending.challenge;
        if challenge.challenge_id != challenge_id
            || Instant::now() >= challenge.expires_at
            || signature.is_empty()
            || signature.len() > 4096
        {
            return Err(AuthorityError::InvalidChallenge);
        }
        let recovery_key = self
            .recovery_public_key
            .as_ref()
            .ok_or(AuthorityError::InvalidCredential)?;
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_ASN1,
            recovery_key,
        )
        .verify(&challenge.bytes, signature)
        .map_err(|_| AuthorityError::InvalidSignature)?;
        if self.devices.contains_key(&challenge.target_device_id) {
            return Err(AuthorityError::InvalidIdentity);
        }
        self.devices.insert(
            challenge.target_device_id.clone(),
            TrustedDevice {
                revoked: false,
                credential: DeviceCredentialRegistration {
                    platform: challenge.target_platform,
                    public_key: challenge.target_public_key,
                },
            },
        );
        Ok(challenge.target_device_id)
    }

    /// Visual/audio cues are prediction signals only; none can create an owner session.
    pub fn observe_owner_candidate(
        &mut self,
        signal: RecognitionSignal,
    ) -> Result<(), AuthorityError> {
        if self.owner_id.is_none() {
            return Err(AuthorityError::NotEnrolled);
        }
        if self.state == AuthState::StepUpRequired {
            return Ok(());
        }
        if !matches!(
            self.state,
            AuthState::Locked | AuthState::GuestActive | AuthState::OwnerCandidate
        ) {
            return Err(AuthorityError::InvalidTransition);
        }
        let from_state = self.state;
        self.state = AuthState::OwnerCandidate;
        if from_state != self.state {
            self.record_audit(
                "owner_candidate_observed",
                from_state,
                self.state,
                format!("signal={signal:?}"),
            );
        }
        Ok(())
    }

    /// Records a local face-recognition observation with liveness gating.
    /// Prepares `OwnerCandidate` only; never creates or extends an owner session.
    pub fn record_face_candidate(
        &mut self,
        confidence: f32,
        liveness_passed: bool,
    ) -> Result<OperatingMode, AuthorityError> {
        self.record_face_candidate_at(confidence, liveness_passed, Instant::now())
    }

    pub fn record_face_candidate_at(
        &mut self,
        confidence: f32,
        liveness_passed: bool,
        now: Instant,
    ) -> Result<OperatingMode, AuthorityError> {
        let current = self.state;
        if !liveness_passed {
            self.record_audit(
                "candidate_face_rejected",
                current,
                current,
                "liveness_failed",
            );
            return Err(AuthorityError::InvalidCredential);
        }
        if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
            self.record_audit(
                "candidate_face_rejected",
                current,
                current,
                "invalid_confidence",
            );
            return Err(AuthorityError::InvalidCredential);
        }
        if confidence < MIN_CANDIDATE_CONFIDENCE {
            self.record_audit(
                "candidate_face_rejected",
                current,
                current,
                format!("low_confidence:{confidence:.3}"),
            );
            return Err(AuthorityError::InvalidCredential);
        }
        if self.owner_id.is_none() {
            return Err(AuthorityError::NotEnrolled);
        }
        if self.state == AuthState::OwnerAuthenticated {
            if self.operating_mode(now) == OperatingMode::OwnerMode {
                self.candidate_signals.face_confidence = Some(confidence);
                return Ok(OperatingMode::OwnerMode);
            }
            self.lock();
        }
        self.observe_owner_candidate(RecognitionSignal::FaceMatch)?;
        self.candidate_signals.face_confidence = Some(confidence);
        self.record_audit(
            "candidate_face_accepted",
            current,
            self.state,
            format!("confidence={confidence:.3}"),
        );
        Ok(self.operating_mode(now))
    }

    /// Records a local speaker-verification observation.
    /// Prepares `OwnerCandidate` only; never creates or extends an owner session.
    pub fn record_voice_candidate(
        &mut self,
        confidence: f32,
    ) -> Result<OperatingMode, AuthorityError> {
        self.record_voice_candidate_at(confidence, Instant::now())
    }

    pub fn record_voice_candidate_at(
        &mut self,
        confidence: f32,
        now: Instant,
    ) -> Result<OperatingMode, AuthorityError> {
        let current = self.state;
        if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
            self.record_audit(
                "candidate_voice_rejected",
                current,
                current,
                "invalid_confidence",
            );
            return Err(AuthorityError::InvalidCredential);
        }
        if confidence < MIN_CANDIDATE_CONFIDENCE {
            self.record_audit(
                "candidate_voice_rejected",
                current,
                current,
                format!("low_confidence:{confidence:.3}"),
            );
            return Err(AuthorityError::InvalidCredential);
        }
        if self.owner_id.is_none() {
            return Err(AuthorityError::NotEnrolled);
        }
        if self.state == AuthState::OwnerAuthenticated {
            if self.operating_mode(now) == OperatingMode::OwnerMode {
                self.candidate_signals.voice_confidence = Some(confidence);
                return Ok(OperatingMode::OwnerMode);
            }
            self.lock();
        }
        self.observe_owner_candidate(RecognitionSignal::VoiceMatch)?;
        self.candidate_signals.voice_confidence = Some(confidence);
        self.record_audit(
            "candidate_voice_accepted",
            current,
            self.state,
            format!("confidence={confidence:.3}"),
        );
        Ok(self.operating_mode(now))
    }

    /// Records supporting gaze/attention presence. Never escalates when `engaged` is false
    /// and never grants owner authority on its own.
    pub fn record_gaze_presence(&mut self, engaged: bool) -> Result<OperatingMode, AuthorityError> {
        self.record_gaze_presence_at(engaged, Instant::now())
    }

    pub fn record_gaze_presence_at(
        &mut self,
        engaged: bool,
        now: Instant,
    ) -> Result<OperatingMode, AuthorityError> {
        if self.owner_id.is_none() {
            return Err(AuthorityError::NotEnrolled);
        }
        self.candidate_signals.gaze_engaged = engaged;
        if !engaged {
            return Ok(self.operating_mode(now));
        }
        if self.state == AuthState::OwnerAuthenticated {
            if self.operating_mode(now) == OperatingMode::OwnerMode {
                return Ok(OperatingMode::OwnerMode);
            }
            self.lock();
        }
        self.observe_owner_candidate(RecognitionSignal::Presence)?;
        Ok(self.operating_mode(now))
    }

    pub fn begin_authentication(
        &mut self,
        device_id: &DeviceId,
    ) -> Result<AuthenticationChallenge, AuthorityError> {
        self.begin_authentication_at(device_id, Instant::now())
    }

    pub fn begin_authentication_at(
        &mut self,
        device_id: &DeviceId,
        now: Instant,
    ) -> Result<AuthenticationChallenge, AuthorityError> {
        if !matches!(
            self.state,
            AuthState::OwnerCandidate | AuthState::StepUpRequired
        ) {
            return Err(AuthorityError::InvalidTransition);
        }
        let prior_state = self.state;
        let Some(device) = self.devices.get(device_id) else {
            self.state = AuthState::DeviceUntrusted;
            self.record_audit(
                "begin_authentication_failed",
                prior_state,
                self.state,
                "unknown_device",
            );
            return Err(AuthorityError::UnknownDevice);
        };
        if device.revoked {
            self.state = AuthState::DeviceUntrusted;
            self.record_audit(
                "begin_authentication_failed",
                prior_state,
                self.state,
                "device_revoked",
            );
            return Err(AuthorityError::DeviceRevoked);
        }
        const CHALLENGE_TTL: Duration = Duration::from_secs(60);
        let expires_at = now
            .checked_add(CHALLENGE_TTL)
            .ok_or(AuthorityError::InvalidSessionLifetime)?;
        let challenge_id = Uuid::new_v4().to_string();
        // UUIDv4 uses the OS CSPRNG. Two independent values provide a 256-bit nonce.
        let mut nonce = Vec::with_capacity(32);
        nonce.extend_from_slice(Uuid::new_v4().as_bytes());
        nonce.extend_from_slice(Uuid::new_v4().as_bytes());
        let owner_id = self.owner_id.as_ref().ok_or(AuthorityError::NotEnrolled)?;
        let mut bytes = b"miss-minutes-owner-auth-v1\0".to_vec();
        append_field(&mut bytes, owner_id.0.as_bytes());
        append_field(&mut bytes, device_id.0.as_bytes());
        append_field(&mut bytes, challenge_id.as_bytes());
        append_field(&mut bytes, &nonce);
        let challenge = AuthenticationChallenge {
            challenge_id,
            device_id: device_id.clone(),
            bytes,
            expires_at,
        };
        self.pending_challenge = Some(PendingChallenge {
            challenge: challenge.clone(),
            prior_state,
        });
        self.state = AuthState::AuthenticationPending;
        self.record_audit(
            "begin_authentication",
            prior_state,
            self.state,
            "challenge_issued",
        );
        Ok(challenge)
    }

    /// Creates a pairing challenge only for a live owner session with owner-profile authority.
    /// Trust is not granted until a valid platform proof from the named source device completes it.
    pub fn begin_device_pairing(
        &mut self,
        owner_session_id: &str,
        target_device_id: DeviceId,
        target_platform: DevicePlatform,
        target_public_key: Vec<u8>,
    ) -> Result<DevicePairingChallenge, AuthorityError> {
        if self.pending_pairing.is_some() {
            return Err(AuthorityError::PairingAlreadyPending);
        }
        if self.devices.len() >= MAX_TRUSTED_DEVICES {
            return Err(AuthorityError::TooManyDevices);
        }
        if !valid_identifier(&target_device_id.0) || self.devices.contains_key(&target_device_id) {
            return Err(AuthorityError::InvalidIdentity);
        }
        validate_public_key(&target_public_key)?;
        let (source_device_id, owner_id) = match self.sessions.get(owner_session_id) {
            Some(Session::Owner(session))
                if !session.revoked
                    && Instant::now() < session.expires_at
                    && session
                        .capabilities
                        .contains(&Capability(capabilities::OWNER_PROFILE_MODIFY.into())) =>
            {
                (session.device_id.clone(), session.owner_id.clone())
            }
            _ => return Err(AuthorityError::InvalidTransition),
        };
        let source = self
            .devices
            .get(&source_device_id)
            .ok_or(AuthorityError::UnknownDevice)?;
        if source.revoked {
            return Err(AuthorityError::DeviceRevoked);
        }

        let challenge_id = Uuid::new_v4().to_string();
        let mut nonce = Vec::with_capacity(32);
        nonce.extend_from_slice(Uuid::new_v4().as_bytes());
        nonce.extend_from_slice(Uuid::new_v4().as_bytes());
        let mut bytes = b"miss-minutes-device-pair-v1\0".to_vec();
        append_field(&mut bytes, owner_id.0.as_bytes());
        append_field(&mut bytes, source_device_id.0.as_bytes());
        append_field(&mut bytes, target_device_id.0.as_bytes());
        append_field(&mut bytes, device_platform_name(target_platform).as_bytes());
        append_field(&mut bytes, &target_public_key);
        append_field(&mut bytes, challenge_id.as_bytes());
        append_field(&mut bytes, &nonce);
        let expires_at = Instant::now()
            .checked_add(DEVICE_PAIRING_TTL)
            .ok_or(AuthorityError::InvalidSessionLifetime)?;
        let challenge = DevicePairingChallenge {
            challenge_id,
            owner_id,
            source_device_id,
            target_device_id,
            target_platform,
            target_public_key,
            nonce,
            bytes,
            expires_at,
        };
        self.pending_pairing = Some(PendingPairing {
            challenge: challenge.clone(),
            owner_session_id: owner_session_id.to_owned(),
        });
        Ok(challenge)
    }

    /// Commits a pairing once the existing device has signed the exact challenge with user
    /// verification. An invalid or expired attempt consumes the pending challenge.
    pub fn complete_device_pairing(
        &mut self,
        challenge_id: &str,
        proof: VerifiedPlatformProof,
    ) -> Result<DeviceId, AuthorityError> {
        let pending = self
            .pending_pairing
            .take()
            .ok_or(AuthorityError::InvalidChallenge)?;
        let challenge = pending.challenge;
        if challenge.challenge_id != challenge_id
            || Instant::now() >= challenge.expires_at
            || proof.challenge != challenge.bytes
        {
            return Err(AuthorityError::InvalidChallenge);
        }
        // A biometric prompt may remain open after the owner locks the app or the session expires.
        // Re-check the exact initiating session at commit time; a previously authorized prompt
        // must not finish a privileged pairing transaction after revocation.
        let session_is_live = self.owner_session_active(&pending.owner_session_id, Instant::now())
            && matches!(self.sessions.get(&pending.owner_session_id),
                Some(Session::Owner(session)) if session.capabilities.contains(
                    &Capability(capabilities::OWNER_PROFILE_MODIFY.into())));
        if !session_is_live {
            return Err(AuthorityError::InvalidTransition);
        }
        let source = self
            .devices
            .get(&challenge.source_device_id)
            .ok_or(AuthorityError::UnknownDevice)?;
        if source.revoked {
            return Err(AuthorityError::DeviceRevoked);
        }
        if source.credential.public_key != proof.public_key {
            return Err(AuthorityError::InvalidSignature);
        }
        if self.devices.contains_key(&challenge.target_device_id) {
            return Err(AuthorityError::InvalidIdentity);
        }
        validate_public_key(&challenge.target_public_key)?;
        self.devices.insert(
            challenge.target_device_id.clone(),
            TrustedDevice {
                revoked: false,
                credential: DeviceCredentialRegistration {
                    platform: challenge.target_platform,
                    public_key: challenge.target_public_key,
                },
            },
        );
        Ok(challenge.target_device_id)
    }

    /// Platform adapter path: verify the source signature against the exact credential and
    /// challenge held by the engine, then commit. No caller-provided public key is accepted.
    pub fn complete_device_pairing_with_signature(
        &mut self,
        challenge_id: &str,
        signature: &[u8],
    ) -> Result<DeviceId, AuthorityError> {
        let pending = self
            .pending_pairing
            .as_ref()
            .ok_or(AuthorityError::InvalidChallenge)?;
        if pending.challenge.challenge_id != challenge_id
            || Instant::now() >= pending.challenge.expires_at
        {
            self.pending_pairing = None;
            return Err(AuthorityError::InvalidChallenge);
        }
        let source = self
            .devices
            .get(&pending.challenge.source_device_id)
            .ok_or(AuthorityError::UnknownDevice)?;
        if source.revoked {
            self.pending_pairing = None;
            return Err(AuthorityError::DeviceRevoked);
        }
        let public_key = source.credential.public_key.clone();
        let bytes = pending.challenge.bytes.clone();
        let proof = match verify_platform_signature(&public_key, &bytes, signature) {
            Ok(proof) => proof,
            Err(error) => {
                self.pending_pairing = None;
                return Err(error);
            }
        };
        self.complete_device_pairing(challenge_id, proof)
    }

    pub fn cancel_device_pairing(&mut self) {
        self.pending_pairing = None;
    }

    /// A cancelled or failed platform prompt returns to a locked state. It never creates a
    /// guest session implicitly; the host must choose guest mode explicitly.
    pub fn cancel_authentication(&mut self) -> Result<(), AuthorityError> {
        if self.state != AuthState::AuthenticationPending {
            return Err(AuthorityError::InvalidTransition);
        }
        let from_state = self.state;
        self.state = self
            .pending_challenge
            .take()
            .map(|pending| resume_after_auth_attempt(pending.prior_state))
            .unwrap_or(AuthState::Locked);
        self.record_audit("cancel_authentication", from_state, self.state, "cancelled");
        Ok(())
    }

    /// Consumes a one-use challenge after verifying the signature using the enrolled device
    /// public key. `assurance` must come from a trusted native adapter that has verified the
    /// platform's user-verification event (for example, a Keystore key gated by BiometricPrompt
    /// or a verified WebAuthn UV assertion). Never call this from renderer, model, plugin,
    /// voice-recognition or external-content code.
    /// Kept crate-private until platform adapters live inside this crate; no downstream app can
    /// mint an owner session by forwarding a renderer-provided assurance value.
    #[allow(dead_code)] // Native adapters are intentionally not wired yet.
    pub(crate) fn complete_owner_authentication(
        &mut self,
        challenge_id: &str,
        signature: &[u8],
        assurance: AuthenticationAssurance,
        lifetime: Duration,
    ) -> Result<OwnerSession, AuthorityError> {
        self.complete_owner_authentication_at(
            challenge_id,
            signature,
            assurance,
            lifetime,
            Instant::now(),
        )
    }

    #[allow(dead_code)]
    pub(crate) fn complete_owner_authentication_at(
        &mut self,
        challenge_id: &str,
        signature: &[u8],
        assurance: AuthenticationAssurance,
        lifetime: Duration,
        now: Instant,
    ) -> Result<OwnerSession, AuthorityError> {
        self.complete_owner_authentication_with_at(
            challenge_id,
            signature,
            assurance,
            lifetime,
            now,
            |credential, challenge, signature| {
                ring::signature::UnparsedPublicKey::new(
                    &ring::signature::ECDSA_P256_SHA256_ASN1,
                    &credential.public_key,
                )
                .verify(challenge, signature)
                .is_ok()
            },
        )
    }

    pub fn complete_owner_authentication_with_verified_proof(
        &mut self,
        challenge_id: &str,
        proof: VerifiedPlatformProof,
        assurance: AuthenticationAssurance,
        lifetime: Duration,
    ) -> Result<OwnerSession, AuthorityError> {
        self.complete_owner_authentication_with_verified_proof_at(
            challenge_id,
            proof,
            assurance,
            lifetime,
            Instant::now(),
        )
    }

    pub fn complete_owner_authentication_with_verified_proof_at(
        &mut self,
        challenge_id: &str,
        proof: VerifiedPlatformProof,
        assurance: AuthenticationAssurance,
        lifetime: Duration,
        now: Instant,
    ) -> Result<OwnerSession, AuthorityError> {
        let expected_challenge = proof.challenge.clone();
        let challenge_for_verifier = expected_challenge.clone();
        let expected_public_key = proof.public_key.clone();
        self.complete_owner_authentication_with_at(
            challenge_id,
            &expected_challenge,
            assurance,
            lifetime,
            now,
            move |credential, challenge, _| {
                credential.public_key == expected_public_key && challenge == challenge_for_verifier
            },
        )
    }

    /// Completes authentication after a trusted platform adapter validates its signed proof
    /// against this device's registered public key and the one-use challenge. This supports
    /// WebAuthn, whose authenticator signs `authenticatorData || SHA256(clientDataJSON)`.
    fn complete_owner_authentication_with_at<F>(
        &mut self,
        challenge_id: &str,
        proof: &[u8],
        assurance: AuthenticationAssurance,
        lifetime: Duration,
        now: Instant,
        verify: F,
    ) -> Result<OwnerSession, AuthorityError>
    where
        F: FnOnce(&DeviceCredentialRegistration, &[u8], &[u8]) -> bool,
    {
        if self.state != AuthState::AuthenticationPending {
            return Err(AuthorityError::InvalidTransition);
        }
        if lifetime.is_zero() || lifetime > MAX_OWNER_SESSION_LIFETIME {
            return Err(AuthorityError::InvalidSessionLifetime);
        }
        let from_state = self.state;
        let Some(pending) = self.pending_challenge.as_ref() else {
            self.state = AuthState::Locked;
            return Err(AuthorityError::InvalidChallenge);
        };
        if pending.challenge.challenge_id != challenge_id {
            return Err(AuthorityError::InvalidChallenge);
        }
        let Some(pending) = self.pending_challenge.take() else {
            self.state = AuthState::Locked;
            return Err(AuthorityError::InvalidChallenge);
        };
        let challenge = pending.challenge;
        if now >= challenge.expires_at {
            self.state = resume_after_auth_attempt(pending.prior_state);
            self.record_audit(
                "owner_auth_failed",
                from_state,
                self.state,
                "challenge_expired",
            );
            return Err(AuthorityError::InvalidChallenge);
        }
        let Some(device) = self.devices.get(&challenge.device_id) else {
            self.state = AuthState::DeviceUntrusted;
            self.record_audit(
                "owner_auth_failed",
                from_state,
                self.state,
                "unknown_device",
            );
            return Err(AuthorityError::UnknownDevice);
        };
        if device.revoked {
            self.state = AuthState::DeviceUntrusted;
            self.record_audit(
                "owner_auth_failed",
                from_state,
                self.state,
                "device_revoked",
            );
            return Err(AuthorityError::DeviceRevoked);
        }
        if proof.is_empty()
            || proof.len() > 64 * 1024
            || !verify(&device.credential, &challenge.bytes, proof)
        {
            self.state = resume_after_auth_attempt(pending.prior_state);
            self.record_audit(
                "owner_auth_failed",
                from_state,
                self.state,
                "invalid_signature",
            );
            return Err(AuthorityError::InvalidSignature);
        }
        let expires_at = now
            .checked_add(lifetime)
            .ok_or(AuthorityError::InvalidSessionLifetime)?;
        let owner_id = self.owner_id.clone().ok_or(AuthorityError::NotEnrolled)?;
        for existing in self.sessions.values_mut() {
            if let Session::Owner(existing_owner) = existing {
                existing_owner.revoked = true;
            }
        }
        let session = OwnerSession {
            owner_id,
            device_id: challenge.device_id,
            session_id: Uuid::new_v4().to_string(),
            issued_at: now,
            expires_at,
            last_owner_activity: now,
            capabilities: self.owner_capabilities.clone(),
            assurance,
            revoked: false,
        };
        self.sessions
            .insert(session.session_id.clone(), Session::Owner(session.clone()));
        self.state = AuthState::OwnerAuthenticated;
        self.record_audit(
            "owner_authenticated",
            from_state,
            self.state,
            "platform_proof_verified",
        );
        Ok(session)
    }

    pub fn start_guest_session(
        &mut self,
        lifetime: Duration,
    ) -> Result<GuestSession, AuthorityError> {
        self.start_guest_session_at(lifetime, Instant::now())
    }

    pub fn start_guest_session_at(
        &mut self,
        lifetime: Duration,
        now: Instant,
    ) -> Result<GuestSession, AuthorityError> {
        if lifetime.is_zero() || lifetime > MAX_GUEST_SESSION_LIFETIME {
            return Err(AuthorityError::InvalidSessionLifetime);
        }
        let expires_at = now
            .checked_add(lifetime)
            .ok_or(AuthorityError::InvalidSessionLifetime)?;
        let session = GuestSession {
            session_id: Uuid::new_v4().to_string(),
            issued_at: now,
            expires_at,
            capabilities: capabilities::guest_allowlist().into_iter().collect(),
        };
        let from_state = self.state;
        self.sessions
            .insert(session.session_id.clone(), Session::Guest(session.clone()));
        self.state = AuthState::GuestActive;
        self.record_audit(
            "guest_session_started",
            from_state,
            self.state,
            "guest_allowlist",
        );
        Ok(session)
    }

    pub fn authorize(
        &mut self,
        session_id: &str,
        command: &CommandRequest,
        now: Instant,
    ) -> AuthorizationResult {
        let current_state = self.state;
        let Some(session) = self.sessions.get_mut(session_id) else {
            self.record_audit(
                "authorize_denied",
                current_state,
                current_state,
                format!("unknown_session cap={}", command.capability.0),
            );
            return deny("unknown_session");
        };
        let mut next_state = current_state;
        let mut audit: Option<(&'static str, String)> = None;
        let decision = match session {
            Session::Owner(s) => {
                if s.revoked || now >= s.expires_at {
                    s.revoked = true;
                    if current_state == AuthState::OwnerAuthenticated && self.owner_id.is_some() {
                        next_state = AuthState::Locked;
                    }
                    audit = Some((
                        "authorize_denied",
                        format!("session_expired_or_revoked cap={}", command.capability.0),
                    ));
                    deny("session_expired_or_revoked")
                } else if now.saturating_duration_since(s.last_owner_activity) >= OWNER_IDLE_TIMEOUT
                {
                    s.revoked = true;
                    if self.owner_id.is_some() {
                        next_state = AuthState::Locked;
                    }
                    audit = Some((
                        "session_idle_timeout",
                        format!("idle_timeout cap={}", command.capability.0),
                    ));
                    deny("session_idle_timeout")
                } else if !s.capabilities.contains(&command.capability) {
                    audit = Some((
                        "authorize_denied",
                        format!("capability_not_granted cap={}", command.capability.0),
                    ));
                    deny("capability_not_granted")
                } else {
                    if matches!(
                        command.origin,
                        CommandOrigin::Model
                            | CommandOrigin::Plugin
                            | CommandOrigin::ExternalContent
                            | CommandOrigin::Notification
                    ) {
                        // These origins can request a capability, but they never establish or alter identity.
                    }
                    if command.risk == Risk::Critical {
                        if now.saturating_duration_since(s.issued_at) > STEP_UP_WINDOW {
                            next_state = AuthState::StepUpRequired;
                            audit = Some((
                                "step_up_required",
                                format!("critical_action cap={}", command.capability.0),
                            ));
                            AuthorizationResult {
                                decision: AuthorizationDecision::FreshAuthenticationRequired,
                                reason: "critical_action_requires_fresh_authentication",
                            }
                        } else {
                            audit = Some((
                                "confirmation_required",
                                format!("critical_action cap={}", command.capability.0),
                            ));
                            AuthorizationResult {
                                decision: AuthorizationDecision::ConfirmationRequired,
                                reason: "critical_action_requires_confirmation",
                            }
                        }
                    } else if command.requires_confirmation || matches!(command.risk, Risk::High) {
                        audit = Some((
                            "confirmation_required",
                            format!("high_risk cap={}", command.capability.0),
                        ));
                        AuthorizationResult {
                            decision: AuthorizationDecision::ConfirmationRequired,
                            reason: "owner_confirmation_required",
                        }
                    } else {
                        s.last_owner_activity = now;
                        allow()
                    }
                }
            }
            Session::Guest(s) => {
                if now >= s.expires_at {
                    audit = Some((
                        "authorize_denied",
                        format!("guest_session_expired cap={}", command.capability.0),
                    ));
                    deny("session_expired")
                } else if !s.capabilities.contains(&command.capability) {
                    audit = Some((
                        "authorize_denied",
                        format!("guest_capability_not_allowed cap={}", command.capability.0),
                    ));
                    deny("guest_capability_not_allowed")
                } else if command.requires_confirmation
                    || matches!(command.risk, Risk::Elevated | Risk::High | Risk::Critical)
                {
                    audit = Some((
                        "authorize_denied",
                        format!("guest_risk_or_confirmation cap={}", command.capability.0),
                    ));
                    deny("guest_confirmation_cannot_grant_authority")
                } else {
                    allow()
                }
            }
        };
        if next_state != self.state {
            self.state = next_state;
        }
        if let Some((event, detail)) = audit {
            self.record_audit(event, current_state, self.state, detail);
        }
        decision
    }

    /// Read-only session liveness check for native UI state. Does not refresh last activity.
    pub fn owner_session_active(&self, session_id: &str, now: Instant) -> bool {
        match self.sessions.get(session_id) {
            Some(Session::Owner(session)) => {
                !session.revoked
                    && now < session.expires_at
                    && now.saturating_duration_since(session.last_owner_activity)
                        < OWNER_IDLE_TIMEOUT
                    && self
                        .devices
                        .get(&session.device_id)
                        .is_some_and(|device| !device.revoked)
            }
            _ => false,
        }
    }

    /// Revoke the current session before a native adapter starts a fresh-authentication prompt.
    pub fn require_step_up(&mut self, session_id: &str, now: Instant) -> bool {
        let Some(Session::Owner(session)) = self.sessions.get_mut(session_id) else {
            return false;
        };
        if session.revoked
            || now >= session.expires_at
            || now.saturating_duration_since(session.last_owner_activity) >= OWNER_IDLE_TIMEOUT
        {
            return false;
        }
        session.revoked = true;
        let from_state = self.state;
        self.pending_challenge = None;
        self.state = AuthState::StepUpRequired;
        self.record_audit(
            "require_step_up",
            from_state,
            self.state,
            "session_revoked_for_step_up",
        );
        true
    }

    pub fn revoke_session(&mut self, session_id: &str) -> bool {
        let found = match self.sessions.get_mut(session_id) {
            Some(Session::Owner(s)) => {
                s.revoked = true;
                true
            }
            Some(Session::Guest(_)) => {
                self.sessions.remove(session_id);
                true
            }
            None => false,
        };
        if found && self.state == AuthState::OwnerAuthenticated {
            let from_state = self.state;
            self.state = AuthState::Revoked;
            self.record_audit("session_revoked", from_state, self.state, "explicit_revoke");
        }
        found
    }

    pub fn revoke_device(&mut self, device_id: &DeviceId) -> Result<(), AuthorityError> {
        let device = self
            .devices
            .get_mut(device_id)
            .ok_or(AuthorityError::UnknownDevice)?;
        device.revoked = true;
        for session in self.sessions.values_mut() {
            if let Session::Owner(s) = session
                && &s.device_id == device_id
            {
                s.revoked = true;
            }
        }
        if self
            .pending_challenge
            .as_ref()
            .is_some_and(|pending| pending.challenge.device_id == *device_id)
        {
            self.pending_challenge = None;
        }
        if self.pending_pairing.as_ref().is_some_and(|pending| {
            pending.challenge.source_device_id == *device_id
                || pending.challenge.target_device_id == *device_id
        }) {
            self.pending_pairing = None;
        }
        if self
            .pending_recovery
            .as_ref()
            .is_some_and(|pending| pending.challenge.target_device_id == *device_id)
        {
            self.pending_recovery = None;
        }
        let from_state = self.state;
        self.state = AuthState::DeviceUntrusted;
        self.record_audit(
            "device_revoked",
            from_state,
            self.state,
            format!("device={}", device_id.0),
        );
        Ok(())
    }

    pub fn lock(&mut self) {
        let from_state = self.state;
        self.pending_challenge = None;
        self.pending_pairing = None;
        self.pending_recovery = None;
        self.candidate_signals = CandidateSignals::default();
        for session in self.sessions.values_mut() {
            if let Session::Owner(s) = session {
                s.revoked = true;
            }
        }
        self.state = if self.owner_id.is_some() {
            AuthState::Locked
        } else {
            AuthState::Unenrolled
        };
        if from_state != self.state {
            self.record_audit("locked", from_state, self.state, "owner_session_locked");
        }
    }

    /// Registers one-time recovery codes hashed with SHA-256 after a fresh live owner session.
    pub fn set_recovery_codes(
        &mut self,
        owner_session_id: &str,
        codes: &[String],
        now: Instant,
    ) -> Result<(), AuthorityError> {
        let Some(Session::Owner(session)) = self.sessions.get(owner_session_id) else {
            return Err(AuthorityError::InvalidTransition);
        };
        if session.revoked
            || now >= session.expires_at
            || now.saturating_duration_since(session.issued_at) > STEP_UP_WINDOW
            || !session
                .capabilities
                .contains(&Capability(capabilities::OWNER_PROFILE_MODIFY.into()))
        {
            return Err(AuthorityError::InvalidTransition);
        }
        if codes.is_empty() || codes.len() > 16 {
            return Err(AuthorityError::InvalidCredential);
        }
        let mut entries = Vec::with_capacity(codes.len());
        for raw in codes {
            let norm = raw.trim().to_ascii_uppercase();
            if norm.len() < 8 {
                return Err(AuthorityError::InvalidCredential);
            }
            let digest: [u8; 32] = Sha256::digest(norm.as_bytes()).into();
            entries.push(RecoveryCodeEntry {
                hash: digest,
                used: false,
            });
        }
        self.recovery_code_hashes = entries;
        self.failed_recovery_attempts = 0;
        self.recovery_locked = false;
        self.record_audit(
            "recovery_codes_rotated",
            self.state,
            self.state,
            format!("count={}", self.recovery_code_hashes.len()),
        );
        Ok(())
    }

    /// Verifies and consumes a single-use recovery code using constant-time digest comparison.
    /// Locks recovery permanently after 3 failed attempts until an owner rotates codes.
    pub fn verify_and_consume_recovery_code(&mut self, code: &str) -> Result<(), AuthorityError> {
        if self.owner_id.is_none() {
            return Err(AuthorityError::NotEnrolled);
        }
        if self.recovery_locked || self.failed_recovery_attempts >= MAX_RECOVERY_ATTEMPTS {
            self.recovery_locked = true;
            return Err(AuthorityError::RecoveryLocked);
        }
        let norm = code.trim().to_ascii_uppercase();
        if norm.is_empty() {
            return Err(AuthorityError::InvalidCredential);
        }
        let probe: [u8; 32] = Sha256::digest(norm.as_bytes()).into();
        let mut matched_idx: Option<usize> = None;
        for (idx, entry) in self.recovery_code_hashes.iter().enumerate() {
            if !entry.used && entry.hash.ct_eq(&probe).unwrap_u8() == 1 {
                matched_idx = Some(idx);
            }
        }
        if let Some(idx) = matched_idx {
            self.recovery_code_hashes[idx].used = true;
            self.failed_recovery_attempts = 0;
            self.record_audit(
                "recovery_code_used",
                self.state,
                self.state,
                "single_use_consumed",
            );
            Ok(())
        } else {
            self.failed_recovery_attempts = self.failed_recovery_attempts.saturating_add(1);
            if self.failed_recovery_attempts >= MAX_RECOVERY_ATTEMPTS {
                self.recovery_locked = true;
                self.record_audit(
                    "recovery_locked",
                    self.state,
                    self.state,
                    "max_attempts_exceeded",
                );
                Err(AuthorityError::RecoveryLocked)
            } else {
                self.record_audit(
                    "recovery_code_failed",
                    self.state,
                    self.state,
                    "invalid_or_reused_code",
                );
                Err(AuthorityError::InvalidCredential)
            }
        }
    }

    /// Exports an AES-256-GCM encrypted enrollment & audit snapshot. Live sessions, monotonic
    /// instants, and transient challenges are strictly omitted so snapshots cannot carry sessions.
    pub fn export_encrypted_snapshot(&self, key: &[u8; 32]) -> Result<Vec<u8>, AuthorityError> {
        let payload = AuthoritySnapshotPayload {
            owner_id: self.owner_id.clone(),
            devices: self.devices.clone(),
            recovery_public_key: self.recovery_public_key.clone(),
            recovery_code_hashes: self.recovery_code_hashes.clone(),
            failed_recovery_attempts: self.failed_recovery_attempts,
            recovery_locked: self.recovery_locked,
            owner_capabilities: self.owner_capabilities.iter().cloned().collect(),
            audit_seq: self.audit_seq,
            audit_entries: self.audit_entries.iter().cloned().collect(),
        };
        let mut plaintext =
            serde_json::to_vec(&payload).map_err(|_| AuthorityError::SnapshotCorrupted)?;
        let rng = SystemRandom::new();
        let mut nonce_bytes = [0u8; 12];
        rng.fill(&mut nonce_bytes)
            .map_err(|_| AuthorityError::SnapshotCorrupted)?;
        let unbound =
            UnboundKey::new(&AES_256_GCM, key).map_err(|_| AuthorityError::InvalidCredential)?;
        let sealing_key = LessSafeKey::new(unbound);
        sealing_key
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce_bytes),
                Aad::from(SNAPSHOT_MAGIC),
                &mut plaintext,
            )
            .map_err(|_| AuthorityError::SnapshotCorrupted)?;
        let mut out =
            Vec::with_capacity(SNAPSHOT_MAGIC.len() + nonce_bytes.len() + plaintext.len());
        out.extend_from_slice(SNAPSHOT_MAGIC);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&plaintext);
        Ok(out)
    }

    pub fn import_encrypted_snapshot(blob: &[u8], key: &[u8; 32]) -> Result<Self, AuthorityError> {
        let header_len = SNAPSHOT_MAGIC.len() + 12;
        if blob.len() <= header_len || &blob[..SNAPSHOT_MAGIC.len()] != SNAPSHOT_MAGIC {
            return Err(AuthorityError::SnapshotCorrupted);
        }
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes.copy_from_slice(&blob[SNAPSHOT_MAGIC.len()..header_len]);
        let mut buf = Zeroizing::new(blob[header_len..].to_vec());
        let unbound =
            UnboundKey::new(&AES_256_GCM, key).map_err(|_| AuthorityError::InvalidCredential)?;
        let opening_key = LessSafeKey::new(unbound);
        let decrypted = opening_key
            .open_in_place(
                Nonce::assume_unique_for_key(nonce_bytes),
                Aad::from(SNAPSHOT_MAGIC),
                &mut buf,
            )
            .map_err(|_| AuthorityError::SnapshotCorrupted)?;
        let payload: AuthoritySnapshotPayload =
            serde_json::from_slice(decrypted).map_err(|_| AuthorityError::SnapshotCorrupted)?;
        let state = if payload.owner_id.is_some() {
            AuthState::Locked
        } else {
            AuthState::Unenrolled
        };
        let mut engine = Self {
            base_instant: Instant::now(),
            owner_id: payload.owner_id,
            state,
            devices: payload.devices,
            pending_challenge: None,
            pending_pairing: None,
            pending_recovery: None,
            recovery_public_key: payload.recovery_public_key,
            recovery_code_hashes: payload.recovery_code_hashes,
            failed_recovery_attempts: payload.failed_recovery_attempts,
            recovery_locked: payload.recovery_locked,
            owner_capabilities: payload.owner_capabilities.into_iter().collect(),
            sessions: HashMap::new(),
            candidate_signals: CandidateSignals::default(),
            audit_seq: payload.audit_seq,
            audit_entries: payload.audit_entries.into_iter().collect(),
        };
        if !engine.verify_audit_chain() {
            return Err(AuthorityError::SnapshotCorrupted);
        }
        engine.record_audit("snapshot_restored", state, state, "locked_no_live_sessions");
        Ok(engine)
    }
}

#[derive(Serialize, Deserialize)]
struct AuthoritySnapshotPayload {
    owner_id: Option<OwnerId>,
    devices: HashMap<DeviceId, TrustedDevice>,
    recovery_public_key: Option<Vec<u8>>,
    recovery_code_hashes: Vec<RecoveryCodeEntry>,
    failed_recovery_attempts: u8,
    recovery_locked: bool,
    owner_capabilities: Vec<Capability>,
    audit_seq: u64,
    audit_entries: Vec<AuditEntry>,
}

pub fn derive_key_pbkdf2(passphrase: &[u8], salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600_000).expect("non-zero iterations"),
        salt,
        passphrase,
        &mut out,
    );
    out
}

pub fn redact_audit_detail(detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    let markers = [
        "sk-",
        "bearer ",
        "token=",
        "password=",
        "secret=",
        "key=",
        "typed_text=",
        "cmd=",
        "biometric=",
    ];
    if let Some((earliest_pos, marker)) = markers
        .iter()
        .filter_map(|m| lower.find(m).map(|pos| (pos, *m)))
        .min_by_key(|(pos, _)| *pos)
    {
        let mut sanitized = detail[..earliest_pos].to_owned();
        sanitized.push_str(&detail[earliest_pos..earliest_pos + marker.len()]);
        sanitized.push_str("[REDACTED]");
        return sanitized;
    }
    if detail.len() > 256 {
        let mut end = 256;
        while end > 0 && !detail.is_char_boundary(end) {
            end -= 1;
        }
        detail[..end].to_owned()
    } else {
        detail.to_owned()
    }
}

fn compute_audit_entry_hash(
    sequence: u64,
    prev_hash: &str,
    event: &str,
    from_state: AuthState,
    to_state: AuthState,
    mode: OperatingMode,
    detail: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(sequence.to_be_bytes());
    hasher.update(prev_hash.as_bytes());
    hasher.update(b"|");
    hasher.update(event.as_bytes());
    hasher.update(b"|");
    hasher.update(format!("{from_state:?}|{to_state:?}|{mode:?}").as_bytes());
    hasher.update(b"|");
    hasher.update(detail.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn append_field(buffer: &mut Vec<u8>, value: &[u8]) {
    buffer.extend_from_slice(&(value.len() as u32).to_be_bytes());
    buffer.extend_from_slice(value);
}

fn validate_public_key(public_key: &[u8]) -> Result<(), AuthorityError> {
    // Platform adapters normalize supported device credentials to uncompressed P-256 SEC1.
    if public_key.len() != 65 || public_key[0] != 0x04 {
        return Err(AuthorityError::InvalidCredential);
    }
    let x_bytes: &[u8; 32] = public_key[1..33]
        .try_into()
        .map_err(|_| AuthorityError::InvalidCredential)?;
    let y_bytes: &[u8; 32] = public_key[33..65]
        .try_into()
        .map_err(|_| AuthorityError::InvalidCredential)?;
    if !is_valid_p256_point(x_bytes, y_bytes) {
        return Err(AuthorityError::InvalidCredential);
    }
    Ok(())
}

/// Validates that uncompressed affine coordinates `(x, y)` represent a canonical point on the
/// NIST P-256 (`secp256r1`) curve: `0 <= x, y < p` and `y^2 == x^3 - 3x + b (mod p)`.
/// Since P-256 has cofactor `h = 1` and uncompressed SEC1 cannot encode infinity, every valid
/// affine point belongs to the prime-order subgroup.
fn is_valid_p256_point(x_bytes: &[u8; 32], y_bytes: &[u8; 32]) -> bool {
    type Fe = [u64; 4];

    // p = 2^256 - 2^224 + 2^192 + 2^96 - 1
    const P: Fe = [
        0xFFFF_FFFF_FFFF_FFFF,
        0x0000_0000_FFFF_FFFF,
        0x0000_0000_0000_0000,
        0xFFFF_FFFF_0000_0001,
    ];
    // b = 0x5ac635d8_aa3a93e7_b3ebbd55_769886bc_651d06b0_cc53b0f6_3bce3c3e_27d2604b
    const B: Fe = [
        0x3BCE_3C3E_27D2_604B,
        0x651D_06B0_CC53_B0F6,
        0xB3EB_BD55_7698_86BC,
        0x5AC6_35D8_AA3A_93E7,
    ];

    fn from_be_bytes(bytes: &[u8; 32]) -> Fe {
        [
            u64::from_be_bytes([
                bytes[24], bytes[25], bytes[26], bytes[27], bytes[28], bytes[29], bytes[30],
                bytes[31],
            ]),
            u64::from_be_bytes([
                bytes[16], bytes[17], bytes[18], bytes[19], bytes[20], bytes[21], bytes[22],
                bytes[23],
            ]),
            u64::from_be_bytes([
                bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14],
                bytes[15],
            ]),
            u64::from_be_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ]),
        ]
    }

    fn cmp_fe(a: Fe, b: Fe) -> std::cmp::Ordering {
        for i in (0..4).rev() {
            match a[i].cmp(&b[i]) {
                std::cmp::Ordering::Equal => continue,
                ord => return ord,
            }
        }
        std::cmp::Ordering::Equal
    }

    fn add_raw(a: Fe, b: Fe) -> (Fe, bool) {
        let mut out = [0u64; 4];
        let mut carry = 0u64;
        for i in 0..4 {
            let (s1, c1) = a[i].overflowing_add(b[i]);
            let (s2, c2) = s1.overflowing_add(carry);
            out[i] = s2;
            carry = u64::from(c1 || c2);
        }
        (out, carry != 0)
    }

    fn sub_raw(a: Fe, b: Fe) -> (Fe, bool) {
        let mut out = [0u64; 4];
        let mut borrow = 0u64;
        for i in 0..4 {
            let (d1, b1) = a[i].overflowing_sub(b[i]);
            let (d2, b2) = d1.overflowing_sub(borrow);
            out[i] = d2;
            borrow = u64::from(b1 || b2);
        }
        (out, borrow != 0)
    }

    fn add_mod(a: Fe, b: Fe) -> Fe {
        let (sum, carry) = add_raw(a, b);
        if carry || cmp_fe(sum, P) != std::cmp::Ordering::Less {
            sub_raw(sum, P).0
        } else {
            sum
        }
    }

    fn sub_mod(a: Fe, b: Fe) -> Fe {
        let (diff, borrow) = sub_raw(a, b);
        if borrow { add_raw(diff, P).0 } else { diff }
    }

    fn mul_mod(a: Fe, b: Fe) -> Fe {
        let mut acc = [0u64; 4];
        for limb in (0..4).rev() {
            for bit in (0..64).rev() {
                acc = add_mod(acc, acc);
                if ((b[limb] >> bit) & 1) != 0 {
                    acc = add_mod(acc, a);
                }
            }
        }
        acc
    }

    let x = from_be_bytes(x_bytes);
    let y = from_be_bytes(y_bytes);
    if cmp_fe(x, P) != std::cmp::Ordering::Less || cmp_fe(y, P) != std::cmp::Ordering::Less {
        return false;
    }

    let lhs = mul_mod(y, y);
    let x2 = mul_mod(x, x);
    let x3 = mul_mod(x2, x);
    let three_x = add_mod(add_mod(x, x), x);
    let rhs = add_mod(sub_mod(x3, three_x), B);
    lhs == rhs
}

fn device_platform_name(platform: DevicePlatform) -> &'static str {
    match platform {
        DevicePlatform::Android => "android",
        DevicePlatform::Windows => "windows",
        DevicePlatform::Linux => "linux",
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn resume_after_auth_attempt(prior_state: AuthState) -> AuthState {
    let _ = prior_state;
    AuthState::Locked
}

fn allow() -> AuthorizationResult {
    AuthorizationResult {
        decision: AuthorizationDecision::Allow,
        reason: "allowed",
    }
}
fn deny(reason: &'static str) -> AuthorizationResult {
    AuthorizationResult {
        decision: AuthorizationDecision::Deny,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;

    struct TestCredential {
        pkcs8: Vec<u8>,
    }

    fn generate_test_credential() -> (TestCredential, Vec<u8>) {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::EcdsaKeyPair::generate_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
            &rng,
        )
        .unwrap();
        let keypair = ring::signature::EcdsaKeyPair::from_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
            pkcs8.as_ref(),
            &rng,
        )
        .unwrap();
        (
            TestCredential {
                pkcs8: pkcs8.as_ref().to_vec(),
            },
            keypair.public_key().as_ref().to_vec(),
        )
    }

    fn sign_for_test(credential: &TestCredential, message: &[u8]) -> Vec<u8> {
        let rng = ring::rand::SystemRandom::new();
        ring::signature::EcdsaKeyPair::from_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
            &credential.pkcs8,
            &rng,
        )
        .unwrap()
        .sign(&rng, message)
        .unwrap()
        .as_ref()
        .to_vec()
    }

    fn capability(name: &str) -> Capability {
        Capability::new(name).unwrap()
    }
    fn request(name: &str, origin: CommandOrigin, risk: Risk, confirm: bool) -> CommandRequest {
        CommandRequest {
            origin,
            capability: capability(name),
            target: "test".into(),
            risk,
            requires_confirmation: confirm,
        }
    }
    fn owner_engine() -> (
        AuthorityEngine,
        DeviceId,
        AuthenticationChallenge,
        TestCredential,
    ) {
        let device = DeviceId("device-1".into());
        let (credential, public_key) = generate_test_credential();
        let mut engine = AuthorityEngine::new();
        engine
            .enroll_owner(
                OwnerId("owner-1".into()),
                device.clone(),
                DeviceCredentialRegistration {
                    platform: DevicePlatform::Windows,
                    public_key,
                },
                [
                    capability(capabilities::PRIVATE_MEMORY_READ),
                    capability(capabilities::PRIVATE_MEMORY_WRITE),
                    capability(capabilities::OWNER_PROFILE_MODIFY),
                ],
            )
            .unwrap();
        engine
            .observe_owner_candidate(RecognitionSignal::FaceMatch)
            .unwrap();
        let challenge = engine.begin_authentication(&device).unwrap();
        (engine, device, challenge, credential)
    }

    #[test]
    fn face_match_only_prepares_candidate_and_never_mints_owner_session() {
        let device = DeviceId("face-device".into());
        let (_, public_key) = generate_test_credential();
        let mut engine = AuthorityEngine::new();
        engine
            .enroll_owner(
                OwnerId("face-owner".into()),
                device.clone(),
                DeviceCredentialRegistration {
                    platform: DevicePlatform::Android,
                    public_key,
                },
                [capability(capabilities::PRIVATE_MEMORY_READ)],
            )
            .unwrap();

        engine
            .observe_owner_candidate(RecognitionSignal::FaceMatch)
            .unwrap();
        assert_eq!(engine.state(), AuthState::OwnerCandidate);
        assert!(engine.sessions.is_empty());
        assert!(!engine.owner_session_active("face-session", Instant::now()));

        let challenge = engine.begin_authentication(&device).unwrap();
        assert_eq!(engine.state(), AuthState::AuthenticationPending);
        assert!(engine.sessions.is_empty());
        assert!(!engine.owner_session_active(&challenge.challenge_id, Instant::now()));
    }

    #[test]
    fn protected_registry_can_restore_a_revoked_device_without_retrusting_it() {
        let owner_device = DeviceId("owner-device".into());
        let revoked_device = DeviceId("revoked-device".into());
        let (_, owner_key) = generate_test_credential();
        let (_, revoked_key) = generate_test_credential();
        let mut engine = AuthorityEngine::new();
        engine
            .enroll_owner(
                OwnerId("revocation-owner".into()),
                owner_device,
                DeviceCredentialRegistration {
                    platform: DevicePlatform::Android,
                    public_key: owner_key,
                },
                [capability(capabilities::OWNER_PROFILE_MODIFY)],
            )
            .unwrap();
        engine
            .restore_revoked_device(
                revoked_device.clone(),
                DeviceCredentialRegistration {
                    platform: DevicePlatform::Windows,
                    public_key: revoked_key,
                },
            )
            .unwrap();
        assert!(engine.devices.get(&revoked_device).unwrap().revoked);
        assert!(matches!(
            engine.begin_authentication(&revoked_device),
            Err(AuthorityError::InvalidTransition) | Err(AuthorityError::DeviceRevoked)
        ));
    }

    fn webauthn_proof(
        credential: &TestCredential,
        challenge: &[u8],
        origin: &str,
        flags: u8,
    ) -> Vec<u8> {
        let rp_id = "missminutes.local";
        let client_data = serde_json::to_vec(&serde_json::json!({
            "type": "webauthn.get",
            "challenge": URL_SAFE_NO_PAD.encode(challenge),
            "origin": origin,
            "crossOrigin": false,
        }))
        .unwrap();
        let mut authenticator_data = Sha256::digest(rp_id.as_bytes()).to_vec();
        authenticator_data.extend_from_slice(&[flags, 0, 0, 0, 1]);
        let mut signed = authenticator_data.clone();
        signed
            .extend_from_slice(ring::digest::digest(&ring::digest::SHA256, &client_data).as_ref());
        let signature = sign_for_test(credential, &signed);
        serde_json::to_vec(&serde_json::json!({
            "credentialId": URL_SAFE_NO_PAD.encode(b"device-credential"),
            "authenticatorData": URL_SAFE_NO_PAD.encode(authenticator_data),
            "signature": URL_SAFE_NO_PAD.encode(signature),
            "clientDataJson": URL_SAFE_NO_PAD.encode(client_data),
        }))
        .unwrap()
    }

    #[test]
    fn verified_webauthn_proof_is_challenge_bound_and_mints_session_only_after_signature_check() {
        let (mut engine, device, challenge, credential) = owner_engine();
        let public_key = engine
            .devices
            .get(&device)
            .unwrap()
            .credential
            .public_key
            .clone();
        let proof_json = webauthn_proof(
            &credential,
            &challenge.bytes,
            "https://missminutes.local",
            0x05,
        );
        let verified = verify_webauthn_assertion(
            &public_key,
            b"device-credential",
            "missminutes.local",
            "https://missminutes.local",
            &challenge.bytes,
            &proof_json,
        )
        .unwrap();
        let session = engine
            .complete_owner_authentication_with_verified_proof(
                &challenge.challenge_id,
                verified,
                AuthenticationAssurance::PlatformUserVerification,
                MAX_OWNER_SESSION_LIFETIME,
            )
            .unwrap();
        assert!(engine.owner_session_active(&session.session_id, Instant::now()));
    }

    #[test]
    fn webauthn_verifier_rejects_wrong_origin_challenge_and_user_verification_flags() {
        let (_engine, _device, challenge, credential) = owner_engine();
        let (_, public_key) = generate_test_credential();
        let valid_public = ring::signature::EcdsaKeyPair::from_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
            &credential.pkcs8,
            &ring::rand::SystemRandom::new(),
        )
        .unwrap()
        .public_key()
        .as_ref()
        .to_vec();
        let wrong_origin = webauthn_proof(
            &credential,
            &challenge.bytes,
            "https://attacker.invalid",
            0x05,
        );
        assert!(
            verify_webauthn_assertion(
                &valid_public,
                b"device-credential",
                "missminutes.local",
                "https://missminutes.local",
                &challenge.bytes,
                &wrong_origin
            )
            .is_err()
        );
        let wrong_flags = webauthn_proof(
            &credential,
            &challenge.bytes,
            "https://missminutes.local",
            0x01,
        );
        assert!(
            verify_webauthn_assertion(
                &valid_public,
                b"device-credential",
                "missminutes.local",
                "https://missminutes.local",
                &challenge.bytes,
                &wrong_flags
            )
            .is_err()
        );
        let wrong_challenge = webauthn_proof(
            &credential,
            b"different challenge",
            "https://missminutes.local",
            0x05,
        );
        assert!(
            verify_webauthn_assertion(
                &valid_public,
                b"device-credential",
                "missminutes.local",
                "https://missminutes.local",
                &challenge.bytes,
                &wrong_challenge
            )
            .is_err()
        );
        assert!(
            verify_webauthn_assertion(
                &public_key,
                b"wrong-credential",
                "missminutes.local",
                "https://missminutes.local",
                &challenge.bytes,
                &wrong_challenge
            )
            .is_err()
        );
    }

    fn authenticate(
        engine: &mut AuthorityEngine,
        challenge: &AuthenticationChallenge,
        credential: &TestCredential,
        lifetime: Duration,
    ) -> OwnerSession {
        let signature = sign_for_test(credential, &challenge.bytes);
        engine
            .complete_owner_authentication(
                &challenge.challenge_id,
                &signature,
                AuthenticationAssurance::PlatformUserVerification,
                lifetime,
            )
            .unwrap()
    }

    #[test]
    fn face_and_voice_are_candidate_only() {
        let (engine, _, _, _) = owner_engine();
        assert_eq!(engine.state(), AuthState::AuthenticationPending);
        assert!(engine.sessions.is_empty());
    }

    #[test]
    fn enrollment_rejects_invalid_identifiers_and_capability_names() {
        let (_, public_key) = generate_test_credential();
        let mut engine = AuthorityEngine::new();
        assert_eq!(
            engine.enroll_owner(
                OwnerId("owner with spaces".into()),
                DeviceId("device-1".into()),
                DeviceCredentialRegistration {
                    platform: DevicePlatform::Windows,
                    public_key: public_key.clone(),
                },
                [],
            ),
            Err(AuthorityError::InvalidIdentity)
        );
        assert_eq!(
            engine.enroll_owner(
                OwnerId("owner-1".into()),
                DeviceId("device-1".into()),
                DeviceCredentialRegistration {
                    platform: DevicePlatform::Windows,
                    public_key,
                },
                [Capability("files.private.read\nsettings.write".into())],
            ),
            Err(AuthorityError::InvalidCapability)
        );
        assert_eq!(engine.state(), AuthState::Unenrolled);
    }

    #[test]
    fn cancelled_authentication_returns_to_locked_without_owner_session() {
        let (mut engine, _, _, _) = owner_engine();
        engine.cancel_authentication().unwrap();
        assert_eq!(engine.state(), AuthState::Locked);
        assert!(engine.sessions.is_empty());
    }

    #[test]
    fn assertion_must_be_valid_and_challenge_is_one_use() {
        let (mut engine, _, challenge, _) = owner_engine();
        assert!(matches!(
            engine.complete_owner_authentication(
                &challenge.challenge_id,
                b"wrong-assertion",
                AuthenticationAssurance::PlatformUserVerification,
                Duration::from_secs(60),
            ),
            Err(AuthorityError::InvalidSignature)
        ));
        assert_eq!(engine.state(), AuthState::Locked);

        let (mut engine, _, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            Duration::from_secs(60),
        );
        assert_eq!(engine.state(), AuthState::OwnerAuthenticated);
        assert!(matches!(
            engine.complete_owner_authentication(
                &challenge.challenge_id,
                &sign_for_test(&credential, &challenge.bytes),
                AuthenticationAssurance::PlatformUserVerification,
                Duration::from_secs(60),
            ),
            Err(AuthorityError::InvalidTransition)
        ));
        assert_eq!(session.device_id, challenge.device_id);
    }

    #[test]
    fn mismatched_challenge_id_does_not_consume_the_pending_challenge() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let signature = sign_for_test(&credential, &challenge.bytes);
        assert!(matches!(
            engine.complete_owner_authentication(
                "another-challenge",
                &signature,
                AuthenticationAssurance::PlatformUserVerification,
                Duration::from_secs(60),
            ),
            Err(AuthorityError::InvalidChallenge)
        ));
        assert_eq!(engine.state(), AuthState::AuthenticationPending);
        assert!(
            engine
                .complete_owner_authentication(
                    &challenge.challenge_id,
                    &signature,
                    AuthenticationAssurance::PlatformUserVerification,
                    Duration::from_secs(60),
                )
                .is_ok()
        );
    }
    #[test]
    fn guest_allowlist_rejects_private_memory() {
        let mut engine = AuthorityEngine::new();
        let guest = engine.start_guest_session(Duration::from_secs(60)).unwrap();
        assert_eq!(
            engine
                .authorize(
                    &guest.session_id,
                    &request(
                        capabilities::GENERAL_CONVERSATION,
                        CommandOrigin::UserInput,
                        Risk::Low,
                        false
                    ),
                    Instant::now()
                )
                .decision,
            AuthorizationDecision::Allow
        );
        assert_eq!(
            engine
                .authorize(
                    &guest.session_id,
                    &request(
                        capabilities::PRIVATE_MEMORY_READ,
                        CommandOrigin::UserInput,
                        Risk::Low,
                        false
                    ),
                    Instant::now()
                )
                .decision,
            AuthorizationDecision::Deny
        );
        assert_eq!(
            engine
                .authorize(
                    &guest.session_id,
                    &request(
                        capabilities::AI_PROVIDER_USE,
                        CommandOrigin::UserInput,
                        Risk::Low,
                        false
                    ),
                    Instant::now()
                )
                .decision,
            AuthorizationDecision::Deny
        );
    }

    #[test]
    fn device_pairing_requires_trusted_source_proof_and_registers_bound_target_key() {
        let (mut engine, source_id, auth, source_key) = owner_engine();
        let source_session = authenticate(&mut engine, &auth, &source_key, Duration::from_secs(60));
        let target_id = DeviceId("android-device-2".into());
        let (target_key, target_public) = generate_test_credential();
        let pairing = engine
            .begin_device_pairing(
                &source_session.session_id,
                target_id.clone(),
                DevicePlatform::Android,
                target_public.clone(),
            )
            .unwrap();
        assert_eq!(pairing.source_device_id, source_id);
        assert_eq!(pairing.target_public_key, target_public);

        let source_public = engine
            .devices
            .get(&source_id)
            .unwrap()
            .credential
            .public_key
            .clone();
        let signature = sign_for_test(&source_key, &pairing.bytes);
        let proof = verify_platform_signature(&source_public, &pairing.bytes, &signature).unwrap();
        assert_eq!(
            engine
                .complete_device_pairing(&pairing.challenge_id, proof)
                .unwrap(),
            target_id
        );
        assert_eq!(
            engine.devices.get(&target_id).unwrap().credential.platform,
            DevicePlatform::Android
        );

        engine.lock();
        engine
            .observe_owner_candidate(RecognitionSignal::Presence)
            .unwrap();
        let target_auth = engine.begin_authentication(&target_id).unwrap();
        let target_session = authenticate(
            &mut engine,
            &target_auth,
            &target_key,
            Duration::from_secs(60),
        );
        assert_eq!(target_session.device_id, target_id);
    }

    #[test]
    fn pairing_rejects_guest_authority_untrusted_sources_and_expired_proofs() {
        let (mut engine, source_id, auth, source_key) = owner_engine();
        let session = authenticate(&mut engine, &auth, &source_key, Duration::from_secs(60));
        let (_, target_public) = generate_test_credential();
        let target_id = DeviceId("android-device-3".into());

        let guest = engine.start_guest_session(Duration::from_secs(60)).unwrap();
        assert_eq!(
            engine
                .begin_device_pairing(
                    &guest.session_id,
                    target_id.clone(),
                    DevicePlatform::Android,
                    target_public.clone()
                )
                .unwrap_err(),
            AuthorityError::InvalidTransition,
        );

        let pairing = engine
            .begin_device_pairing(
                &session.session_id,
                target_id.clone(),
                DevicePlatform::Android,
                target_public,
            )
            .unwrap();
        let (impostor, _) = generate_test_credential();
        let bad_signature = sign_for_test(&impostor, &pairing.bytes);
        assert!(
            verify_platform_signature(
                &engine
                    .devices
                    .get(&source_id)
                    .unwrap()
                    .credential
                    .public_key,
                &pairing.bytes,
                &bad_signature,
            )
            .is_err()
        );
        assert!(!engine.devices.contains_key(&target_id));

        engine.cancel_device_pairing();
        let second = engine
            .begin_device_pairing(
                &session.session_id,
                target_id.clone(),
                DevicePlatform::Android,
                generate_test_credential().1,
            )
            .unwrap();
        let valid_signature = sign_for_test(&source_key, &second.bytes);
        let valid_proof = verify_platform_signature(
            &engine
                .devices
                .get(&source_id)
                .unwrap()
                .credential
                .public_key,
            &second.bytes,
            &valid_signature,
        )
        .unwrap();
        engine
            .pending_pairing
            .as_mut()
            .unwrap()
            .challenge
            .expires_at = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            engine
                .complete_device_pairing(&second.challenge_id, valid_proof)
                .unwrap_err(),
            AuthorityError::InvalidChallenge,
        );
        assert!(!engine.devices.contains_key(&target_id));

        let third = engine
            .begin_device_pairing(
                &session.session_id,
                target_id.clone(),
                DevicePlatform::Android,
                generate_test_credential().1,
            )
            .unwrap();
        let signature = sign_for_test(&source_key, &third.bytes);
        let proof = verify_platform_signature(
            &engine
                .devices
                .get(&source_id)
                .unwrap()
                .credential
                .public_key,
            &third.bytes,
            &signature,
        )
        .unwrap();
        engine.revoke_device(&source_id).unwrap();
        assert_eq!(
            engine
                .complete_device_pairing(&third.challenge_id, proof)
                .unwrap_err(),
            AuthorityError::InvalidChallenge,
        );
        assert!(!engine.devices.contains_key(&target_id));
    }

    #[test]
    fn pairing_prompt_cannot_commit_after_the_initiating_owner_session_is_locked() {
        let (mut engine, _, auth, source_key) = owner_engine();
        let session = authenticate(&mut engine, &auth, &source_key, Duration::from_secs(60));
        let (_, target_public) = generate_test_credential();
        let target_id = DeviceId("pairing-target-lock-test".into());
        let challenge = engine
            .begin_device_pairing(
                &session.session_id,
                target_id.clone(),
                DevicePlatform::Android,
                target_public,
            )
            .unwrap();
        let signature = sign_for_test(&source_key, &challenge.bytes);
        let source_public = engine
            .devices
            .get(&session.device_id)
            .unwrap()
            .credential
            .public_key
            .clone();
        let proof =
            verify_platform_signature(&source_public, &challenge.bytes, &signature).unwrap();

        assert!(engine.revoke_session(&session.session_id));
        assert_eq!(
            engine
                .complete_device_pairing(&challenge.challenge_id, proof)
                .unwrap_err(),
            AuthorityError::InvalidTransition
        );
        assert!(!engine.devices.contains_key(&target_id));
    }

    #[test]
    fn offline_recovery_key_is_fresh_auth_gated_and_adds_only_the_signed_device() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            Duration::from_secs(60),
        );
        let (recovery_key, recovery_public) = generate_test_credential();
        engine
            .set_recovery_public_key(&session.session_id, recovery_public, Instant::now())
            .unwrap();

        let target_id = DeviceId("replacement-android".into());
        let (target_key, target_public) = generate_test_credential();
        let recovery = engine
            .begin_device_recovery(
                target_id.clone(),
                DevicePlatform::Android,
                target_public.clone(),
            )
            .unwrap();
        let recovery_signature = sign_for_test(&recovery_key, &recovery.bytes);
        assert_eq!(
            engine
                .complete_device_recovery(&recovery.challenge_id, &recovery_signature)
                .unwrap(),
            target_id
        );
        let trusted = engine.devices.get(&target_id).unwrap();
        assert_eq!(trusted.credential.platform, DevicePlatform::Android);
        assert_eq!(trusted.credential.public_key, target_public);

        // The newly trusted credential can authenticate only by proving its own private key.
        engine.lock();
        engine
            .observe_owner_candidate(RecognitionSignal::Presence)
            .unwrap();
        let replacement_challenge = engine.begin_authentication(&target_id).unwrap();
        let signature = sign_for_test(&target_key, &replacement_challenge.bytes);
        let recovered_session = engine
            .complete_owner_authentication(
                &replacement_challenge.challenge_id,
                &signature,
                AuthenticationAssurance::PlatformUserVerification,
                Duration::from_secs(60),
            )
            .unwrap();
        assert_eq!(recovered_session.device_id, target_id);
    }

    #[test]
    fn clean_install_recovery_bootstrap_requires_the_offline_signature_before_device_trust() {
        let owner_id = OwnerId("offline-owner-recovery".into());
        let (recovery_key, recovery_public) = generate_test_credential();
        let mut engine = AuthorityEngine::new();
        engine
            .bootstrap_recovery_identity(owner_id.clone(), recovery_public.clone())
            .unwrap();
        assert_eq!(engine.state(), AuthState::Locked);
        assert_eq!(engine.owner_id(), Some(&owner_id));
        assert!(engine.devices.is_empty());
        assert_eq!(
            engine
                .bootstrap_recovery_identity(owner_id.clone(), recovery_public.clone())
                .unwrap_err(),
            AuthorityError::AlreadyEnrolled,
        );

        let target_id = DeviceId("recovered-new-device".into());
        let (target_key, target_public) = generate_test_credential();
        let challenge = engine
            .begin_device_recovery(
                target_id.clone(),
                DevicePlatform::Android,
                target_public.clone(),
            )
            .unwrap();
        let (impostor, _) = generate_test_credential();
        assert_eq!(
            engine
                .complete_device_recovery(
                    &challenge.challenge_id,
                    &sign_for_test(&impostor, &challenge.bytes)
                )
                .unwrap_err(),
            AuthorityError::InvalidSignature,
        );
        assert!(!engine.devices.contains_key(&target_id));

        let challenge = engine
            .begin_device_recovery(target_id.clone(), DevicePlatform::Android, target_public)
            .unwrap();
        let signature = sign_for_test(&recovery_key, &challenge.bytes);
        assert_eq!(
            engine
                .complete_device_recovery(&challenge.challenge_id, &signature)
                .unwrap(),
            target_id
        );
        engine
            .observe_owner_candidate(RecognitionSignal::Presence)
            .unwrap();
        let auth = engine.begin_authentication(&target_id).unwrap();
        let session = engine
            .complete_owner_authentication(
                &auth.challenge_id,
                &sign_for_test(&target_key, &auth.bytes),
                AuthenticationAssurance::HardwareBackedPlatformUserVerification,
                Duration::from_secs(60),
            )
            .unwrap();
        assert_eq!(session.owner_id, owner_id);
        assert_eq!(session.device_id, target_id);
    }

    #[test]
    fn recovery_rejects_missing_credential_wrong_signature_and_replay() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            Duration::from_secs(60),
        );
        let (recovery_key, recovery_public) = generate_test_credential();
        engine
            .set_recovery_public_key(&session.session_id, recovery_public, Instant::now())
            .unwrap();
        let (_, target_public) = generate_test_credential();
        let target_id = DeviceId("replacement-linux".into());
        let challenge = engine
            .begin_device_recovery(target_id.clone(), DevicePlatform::Linux, target_public)
            .unwrap();
        let (impostor, _) = generate_test_credential();
        let bad = sign_for_test(&impostor, &challenge.bytes);
        assert_eq!(
            engine
                .complete_device_recovery(&challenge.challenge_id, &bad)
                .unwrap_err(),
            AuthorityError::InvalidSignature
        );
        assert!(!engine.devices.contains_key(&target_id));
        assert_eq!(
            engine
                .complete_device_recovery(
                    &challenge.challenge_id,
                    &sign_for_test(&recovery_key, &challenge.bytes)
                )
                .unwrap_err(),
            AuthorityError::InvalidChallenge
        );

        let fresh = engine.start_guest_session(Duration::from_secs(60)).unwrap();
        let (_, new_key) = generate_test_credential();
        assert_eq!(
            engine
                .set_recovery_public_key(&fresh.session_id, new_key, Instant::now())
                .unwrap_err(),
            AuthorityError::InvalidTransition
        );
    }

    #[test]
    fn owner_only_provider_capability_is_not_granted_to_guests() {
        let mut engine = AuthorityEngine::new();
        let guest = engine.start_guest_session(Duration::from_secs(60)).unwrap();
        let use_provider = request(
            capabilities::AI_PROVIDER_USE,
            CommandOrigin::UserInput,
            Risk::Low,
            false,
        );
        assert_eq!(
            engine
                .authorize(&guest.session_id, &use_provider, Instant::now())
                .decision,
            AuthorizationDecision::Deny
        );
    }

    #[test]
    fn private_store_write_is_owner_session_gated() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            Duration::from_secs(60),
        );
        let write = request(
            capabilities::PRIVATE_MEMORY_WRITE,
            CommandOrigin::UserInput,
            Risk::Low,
            false,
        );
        assert_eq!(
            engine
                .authorize(&session.session_id, &write, Instant::now())
                .decision,
            AuthorizationDecision::Allow
        );

        let mut guest_engine = AuthorityEngine::new();
        let guest = guest_engine
            .start_guest_session(Duration::from_secs(60))
            .unwrap();
        assert_eq!(
            guest_engine
                .authorize(&guest.session_id, &write, Instant::now())
                .decision,
            AuthorizationDecision::Deny
        );
    }
    #[test]
    fn external_content_cannot_promote_itself_to_owner_or_gain_capabilities() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            Duration::from_secs(60),
        );
        let denied = engine.authorize(
            &session.session_id,
            &request(
                "settings.security.write",
                CommandOrigin::ExternalContent,
                Risk::Low,
                false,
            ),
            Instant::now(),
        );
        assert_eq!(denied.decision, AuthorizationDecision::Deny);
        assert_eq!(engine.state(), AuthState::OwnerAuthenticated);
    }
    #[test]
    fn high_risk_needs_confirmation_and_critical_needs_fresh_authentication() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let cap = capability(capabilities::PRIVATE_MEMORY_READ);
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            Duration::from_secs(60),
        );
        assert_eq!(
            engine
                .authorize(
                    &session.session_id,
                    &CommandRequest {
                        origin: CommandOrigin::VoiceInput,
                        capability: cap.clone(),
                        target: "x".into(),
                        risk: Risk::High,
                        requires_confirmation: false
                    },
                    Instant::now()
                )
                .decision,
            AuthorizationDecision::ConfirmationRequired
        );
        assert_eq!(
            engine
                .authorize(
                    &session.session_id,
                    &CommandRequest {
                        origin: CommandOrigin::VoiceInput,
                        capability: cap,
                        target: "x".into(),
                        risk: Risk::Critical,
                        requires_confirmation: false
                    },
                    Instant::now()
                )
                .decision,
            AuthorizationDecision::ConfirmationRequired
        );
    }

    #[test]
    fn critical_action_requires_step_up_after_authentication_window() {
        let (mut engine, device, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            Duration::from_secs(60),
        );
        let request = request(
            capabilities::PRIVATE_MEMORY_READ,
            CommandOrigin::UserInput,
            Risk::Critical,
            true,
        );
        assert_eq!(
            engine
                .authorize(
                    &session.session_id,
                    &request,
                    session.issued_at + STEP_UP_WINDOW + Duration::from_secs(1),
                )
                .decision,
            AuthorizationDecision::FreshAuthenticationRequired
        );
        assert_eq!(engine.state(), AuthState::StepUpRequired);

        let challenge = engine.begin_authentication(&device).unwrap();
        let _renewed = authenticate(
            &mut engine,
            &challenge,
            &credential,
            Duration::from_secs(60),
        );
        assert_eq!(engine.state(), AuthState::OwnerAuthenticated);
    }
    #[test]
    fn device_revocation_invalidates_owner_session() {
        let (mut engine, device, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            Duration::from_secs(60),
        );
        engine.revoke_device(&device).unwrap();
        assert_eq!(
            engine
                .authorize(
                    &session.session_id,
                    &request(
                        capabilities::PRIVATE_MEMORY_READ,
                        CommandOrigin::UserInput,
                        Risk::Low,
                        false
                    ),
                    Instant::now()
                )
                .decision,
            AuthorizationDecision::Deny
        );
    }
    #[test]
    fn expiry_and_explicit_lock_invalidate_owner_session() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let session = authenticate(&mut engine, &challenge, &credential, Duration::from_secs(1));
        let request = request(
            capabilities::PRIVATE_MEMORY_READ,
            CommandOrigin::UserInput,
            Risk::Low,
            false,
        );
        assert_eq!(
            engine
                .authorize(&session.session_id, &request, session.expires_at)
                .decision,
            AuthorizationDecision::Deny
        );
        engine.lock();
        assert_eq!(engine.state(), AuthState::Locked);
        assert_eq!(
            engine
                .authorize(&session.session_id, &request, Instant::now())
                .decision,
            AuthorizationDecision::Deny
        );
    }

    #[test]
    fn owner_session_liveness_check_does_not_extend_session() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            MAX_OWNER_SESSION_LIFETIME,
        );
        let last_activity = session.last_owner_activity;
        let now = Instant::now();
        assert!(engine.owner_session_active(&session.session_id, now));
        assert_eq!(
            engine
                .sessions
                .get(&session.session_id)
                .map(|stored| match stored {
                    Session::Owner(owner) => owner.last_owner_activity,
                    Session::Guest(_) => panic!("unexpected guest session"),
                }),
            Some(last_activity)
        );
        engine.lock();
        assert!(!engine.owner_session_active(&session.session_id, Instant::now()));
    }

    #[test]
    fn fresh_authentication_revokes_the_previous_owner_session() {
        let (mut engine, device, challenge, credential) = owner_engine();
        let first = authenticate(
            &mut engine,
            &challenge,
            &credential,
            MAX_OWNER_SESSION_LIFETIME,
        );
        assert!(engine.require_step_up(&first.session_id, Instant::now()));
        assert!(!engine.owner_session_active(&first.session_id, Instant::now()));
        engine
            .observe_owner_candidate(RecognitionSignal::Presence)
            .unwrap();
        let next_challenge = engine.begin_authentication(&device).unwrap();
        let signature = sign_for_test(&credential, &next_challenge.bytes);
        let second = engine
            .complete_owner_authentication(
                &next_challenge.challenge_id,
                &signature,
                AuthenticationAssurance::PlatformUserVerification,
                MAX_OWNER_SESSION_LIFETIME,
            )
            .unwrap();
        assert!(engine.owner_session_active(&second.session_id, Instant::now()));
        assert!(!engine.owner_session_active(&first.session_id, Instant::now()));
    }

    #[test]
    fn cancelled_step_up_leaves_the_owner_session_locked() {
        let (mut engine, device, challenge, credential) = owner_engine();
        let first = authenticate(
            &mut engine,
            &challenge,
            &credential,
            MAX_OWNER_SESSION_LIFETIME,
        );
        assert!(engine.require_step_up(&first.session_id, Instant::now()));
        engine
            .observe_owner_candidate(RecognitionSignal::Presence)
            .unwrap();
        engine.begin_authentication(&device).unwrap();
        engine.cancel_authentication().unwrap();
        assert_eq!(engine.state(), AuthState::Locked);
        assert!(!engine.owner_session_active(&first.session_id, Instant::now()));
    }

    #[test]
    fn candidate_state_cannot_execute_private_tool() {
        let device = DeviceId("cand-device".into());
        let (_, public_key) = generate_test_credential();
        let mut engine = AuthorityEngine::new();
        engine
            .enroll_owner(
                OwnerId("cand-owner".into()),
                device,
                DeviceCredentialRegistration {
                    platform: DevicePlatform::Windows,
                    public_key,
                },
                [
                    capability(capabilities::PRIVATE_MEMORY_READ),
                    capability(capabilities::PRIVATE_FILES_READ),
                    capability(capabilities::DEVICE_CONTROL),
                ],
            )
            .unwrap();
        assert_eq!(
            engine.operating_mode(Instant::now()),
            OperatingMode::GuestMode
        );

        // Spoofed/low-confidence face match must be rejected without entering candidate mode.
        assert_eq!(
            engine.record_face_candidate(0.95, false),
            Err(AuthorityError::InvalidCredential)
        );
        assert_eq!(
            engine.record_face_candidate(0.42, true),
            Err(AuthorityError::InvalidCredential)
        );
        assert_eq!(
            engine.operating_mode(Instant::now()),
            OperatingMode::GuestMode
        );

        // High-confidence face + voice + gaze fuse into OwnerCandidate only, never OwnerMode.
        assert_eq!(
            engine.record_face_candidate(0.92, true).unwrap(),
            OperatingMode::OwnerCandidate
        );
        assert_eq!(
            engine.record_voice_candidate(0.85).unwrap(),
            OperatingMode::OwnerCandidate
        );
        assert_eq!(
            engine.record_gaze_presence(true).unwrap(),
            OperatingMode::OwnerCandidate
        );
        assert!(engine.candidate_confidence() > 0.80);
        assert!(engine.sessions.is_empty());

        // Candidate has no owner session and cannot execute any private capability.
        let decision = engine.authorize(
            "candidate-forged-session",
            &request(
                capabilities::PRIVATE_FILES_READ,
                CommandOrigin::VoiceInput,
                Risk::Low,
                false,
            ),
            Instant::now(),
        );
        assert_eq!(decision.decision, AuthorizationDecision::Deny);
    }

    #[test]
    fn step_up_required_for_destructive_action() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            MAX_OWNER_SESSION_LIFETIME,
        );
        let destructive = request(
            capabilities::PRIVATE_MEMORY_WRITE,
            CommandOrigin::UserInput,
            Risk::Critical,
            true,
        );
        let later = session.issued_at + STEP_UP_WINDOW + Duration::from_secs(5);
        let result = engine.authorize(&session.session_id, &destructive, later);
        assert_eq!(
            result.decision,
            AuthorizationDecision::FreshAuthenticationRequired
        );
        assert_eq!(engine.state(), AuthState::StepUpRequired);
        assert_eq!(engine.operating_mode(later), OperatingMode::GuestMode);
        assert!(
            engine
                .audit_log()
                .iter()
                .any(|entry| entry.event == "step_up_required")
        );
    }

    #[test]
    fn session_revocation_on_lock() {
        let (mut engine, _, challenge, credential) = owner_engine();
        let session = authenticate(
            &mut engine,
            &challenge,
            &credential,
            MAX_OWNER_SESSION_LIFETIME,
        );
        assert_eq!(
            engine.operating_mode(Instant::now()),
            OperatingMode::OwnerMode
        );
        assert!(engine.owner_session_active(&session.session_id, Instant::now()));

        // Idle timeout also invalidates owner session without allowing continuation.
        let idle_at = session.last_owner_activity + OWNER_IDLE_TIMEOUT;
        assert!(!engine.owner_session_active(&session.session_id, idle_at));
        assert_eq!(engine.operating_mode(idle_at), OperatingMode::GuestMode);

        // Re-verify explicit lock revokes immediately and clears candidate signals.
        let (mut engine2, _, challenge2, credential2) = owner_engine();
        let session2 = authenticate(
            &mut engine2,
            &challenge2,
            &credential2,
            MAX_OWNER_SESSION_LIFETIME,
        );
        engine2.lock();
        assert_eq!(engine2.state(), AuthState::Locked);
        assert_eq!(
            engine2.operating_mode(Instant::now()),
            OperatingMode::GuestMode
        );
        assert!(!engine2.owner_session_active(&session2.session_id, Instant::now()));
        assert_eq!(
            engine2
                .authorize(
                    &session2.session_id,
                    &request(
                        capabilities::PRIVATE_MEMORY_READ,
                        CommandOrigin::UserInput,
                        Risk::Low,
                        false
                    ),
                    Instant::now()
                )
                .decision,
            AuthorizationDecision::Deny
        );
    }

    #[test]
    fn guest_allowlist_enforcement() {
        let mut engine = AuthorityEngine::new();
        let guest = engine.start_guest_session(Duration::from_secs(60)).unwrap();
        assert_eq!(
            engine.operating_mode(Instant::now()),
            OperatingMode::GuestMode
        );

        for allowed_cap in capabilities::guest_allowlist() {
            assert_eq!(
                engine
                    .authorize(
                        &guest.session_id,
                        &request(&allowed_cap.0, CommandOrigin::UserInput, Risk::Low, false),
                        Instant::now(),
                    )
                    .decision,
                AuthorizationDecision::Allow
            );
        }

        for denied_cap in [
            capabilities::PRIVATE_MEMORY_READ,
            capabilities::PRIVATE_MEMORY_WRITE,
            capabilities::PRIVATE_FILES_READ,
            capabilities::SETTINGS_MODIFY,
            capabilities::AI_PROVIDER_USE,
            capabilities::DEVICE_CONTROL,
            capabilities::OWNER_PROFILE_MODIFY,
        ] {
            assert_eq!(
                engine
                    .authorize(
                        &guest.session_id,
                        &request(denied_cap, CommandOrigin::UserInput, Risk::Low, false),
                        Instant::now(),
                    )
                    .decision,
                AuthorizationDecision::Deny
            );
        }

        assert_eq!(
            engine
                .authorize(
                    &guest.session_id,
                    &request(
                        capabilities::HARMLESS_TASK,
                        CommandOrigin::UserInput,
                        Risk::Elevated,
                        false
                    ),
                    Instant::now(),
                )
                .decision,
            AuthorizationDecision::Deny
        );
    }

    #[test]
    fn deterministic_time_injected_expiry_idle_and_step_up_tests() {
        let mut engine = AuthorityEngine::new();
        let t0 = engine.instant_at_ms(1_000);
        let device = DeviceId("det-dev-1".into());
        let (cred, pubk) = generate_test_credential();
        engine
            .enroll_owner(
                OwnerId("det-owner".into()),
                device.clone(),
                DeviceCredentialRegistration {
                    platform: DevicePlatform::Windows,
                    public_key: pubk,
                },
                [capability(capabilities::PRIVATE_MEMORY_READ)],
            )
            .unwrap();
        engine.record_face_candidate_at(0.90, true, t0).unwrap();
        let ch = engine.begin_authentication_at(&device, t0).unwrap();
        let sig = sign_for_test(&cred, &ch.bytes);
        let session = engine
            .complete_owner_authentication_at(
                &ch.challenge_id,
                &sig,
                AuthenticationAssurance::HardwareBackedPlatformUserVerification,
                Duration::from_secs(1800),
                t0,
            )
            .unwrap();

        let t_idle = engine.instant_at_ms(1_000 + OWNER_IDLE_TIMEOUT.as_millis() as u64 + 1);
        assert!(!engine.owner_session_active(&session.session_id, t_idle));
        assert_eq!(engine.operating_mode(t_idle), OperatingMode::GuestMode);
    }

    #[test]
    fn hash_chained_audit_log_detects_tampering_and_redacts_secrets() {
        let mut engine = AuthorityEngine::new();
        engine.record_audit(
            "secret_probe",
            AuthState::Locked,
            AuthState::Locked,
            "typed_text=my_super_secret_password sk-live-secret-token",
        );
        let entries = engine.audit_log();
        assert!(entries[0].detail.contains("[REDACTED]"));
        assert!(!entries[0].detail.contains("my_super_secret_password"));
        assert!(engine.verify_audit_chain());

        // Corrupting any entry breaks verify_audit_chain()
        if let Some(front) = engine.audit_entries.front_mut() {
            front.detail.push_str("_tampered");
        }
        assert!(!engine.verify_audit_chain());
    }

    #[test]
    fn encrypted_authority_snapshot_round_trips_without_restoring_sessions() {
        let (mut engine, _, ch, cred) = owner_engine();
        let session = authenticate(&mut engine, &ch, &cred, Duration::from_secs(600));
        let key = derive_key_pbkdf2(b"passphrase-test", b"salt-1234567890");
        let blob = engine.export_encrypted_snapshot(&key).unwrap();

        // Wrong key or corrupted ciphertext fails closed
        let bad_key = derive_key_pbkdf2(b"wrong-passphrase", b"salt-1234567890");
        assert!(AuthorityEngine::import_encrypted_snapshot(&blob, &bad_key).is_err());

        let restored = AuthorityEngine::import_encrypted_snapshot(&blob, &key).unwrap();
        assert_eq!(restored.state(), AuthState::Locked);
        assert!(!restored.owner_session_active(&session.session_id, Instant::now()));
        assert!(restored.verify_audit_chain());
    }

    #[test]
    fn recovery_codes_are_single_use_and_lock_out_after_three_failures() {
        let (mut engine, _, ch, cred) = owner_engine();
        let session = authenticate(&mut engine, &ch, &cred, Duration::from_secs(600));
        engine
            .set_recovery_codes(
                &session.session_id,
                &["ABCD-1234-EFGH".into(), "IJKL-5678-MNOP".into()],
                session.issued_at,
            )
            .unwrap();

        engine
            .verify_and_consume_recovery_code("abcd-1234-efgh")
            .unwrap();
        // Reuse rejected
        assert_eq!(
            engine.verify_and_consume_recovery_code("ABCD-1234-EFGH"),
            Err(AuthorityError::InvalidCredential)
        );
        // Second wrong guess
        assert_eq!(
            engine.verify_and_consume_recovery_code("WRONG-CODE-2222"),
            Err(AuthorityError::InvalidCredential)
        );
        // Third wrong guess triggers lockout
        assert_eq!(
            engine.verify_and_consume_recovery_code("WRONG-CODE-3333"),
            Err(AuthorityError::RecoveryLocked)
        );
        assert!(engine.is_recovery_locked());
        // Valid remaining code blocked once locked out
        assert_eq!(
            engine.verify_and_consume_recovery_code("IJKL-5678-MNOP"),
            Err(AuthorityError::RecoveryLocked)
        );
    }

    #[test]
    fn emergency_kill_wipes_all_sessions_candidates_and_challenges() {
        let (mut engine, device, ch, cred) = owner_engine();
        let session = authenticate(&mut engine, &ch, &cred, Duration::from_secs(600));
        engine.record_face_candidate(0.92, true).unwrap();
        engine.emergency_kill();
        assert_eq!(engine.state(), AuthState::Locked);
        assert!(!engine.owner_session_active(&session.session_id, Instant::now()));
        assert_eq!(engine.candidate_confidence(), 0.0);
        assert_eq!(
            engine.begin_authentication(&device),
            Err(AuthorityError::InvalidTransition)
        );
    }
}
