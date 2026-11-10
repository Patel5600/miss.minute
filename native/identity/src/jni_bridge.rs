//! Small JNI boundary for the Android host. This is callable only from native app code; the
//! WebView message protocol intentionally has no path to these methods.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use jni::JNIEnv;
use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jboolean, jstring};

use crate::{
    AuthenticationAssurance, AuthorityEngine, Capability, CommandOrigin, CommandRequest, Risk,
    DeviceCredentialRegistration, DeviceId, DevicePlatform, OwnerId, RecognitionSignal,
    capabilities,
};

static AUTHORITY: OnceLock<Mutex<AuthorityEngine>> = OnceLock::new();

fn authority() -> &'static Mutex<AuthorityEngine> {
    AUTHORITY.get_or_init(|| Mutex::new(AuthorityEngine::new()))
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeResetAuthority(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = authority().lock().map_err(|_| "authority_unavailable".to_owned()).map(|mut engine| {
        *engine = AuthorityEngine::new();
        "reset".to_owned()
    });
    result_string(&mut env, result)
}

fn result_string<'local>(env: &mut JNIEnv<'local>, value: Result<String, String>) -> jstring {
    let value = value.unwrap_or_else(|error| format!("error:{error}"));
    match env.new_string(value) {
        Ok(value) => value.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

fn read_string(env: &mut JNIEnv<'_>, value: &JString<'_>) -> Result<String, String> {
    env.get_string(value)
        .map(|value| value.into())
        .map_err(|_| "invalid_string".to_owned())
}

fn read_platform(value: &str) -> Result<DevicePlatform, String> {
    match value {
        "android" => Ok(DevicePlatform::Android),
        "windows" => Ok(DevicePlatform::Windows),
        "linux" => Ok(DevicePlatform::Linux),
        _ => Err("invalid_platform".to_owned()),
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes { let _ = write!(&mut encoded, "{byte:02x}"); }
    encoded
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeEnroll(
    mut env: JNIEnv,
    _class: JClass,
    owner_id: JString,
    device_id: JString,
    public_key: JByteArray,
) -> jstring {
    let result = (|| {
        let owner_id = read_string(&mut env, &owner_id)?;
        let device_id = read_string(&mut env, &device_id)?;
        let public_key = env
            .convert_byte_array(public_key)
            .map_err(|_| "invalid_public_key".to_owned())?;
        let mut engine = authority()
            .lock()
            .map_err(|_| "authority_unavailable".to_owned())?;
        engine
            .enroll_owner(
                OwnerId(owner_id),
                DeviceId(device_id),
                DeviceCredentialRegistration {
                    platform: DevicePlatform::Android,
                    public_key,
                },
                [
                    Capability::new(capabilities::GENERAL_CONVERSATION)
                        .map_err(|_| "invalid_policy")?,
                    Capability::new(capabilities::PUBLIC_INFORMATION)
                        .map_err(|_| "invalid_policy")?,
                    Capability::new(capabilities::HARMLESS_TASK).map_err(|_| "invalid_policy")?,
                    Capability::new(capabilities::PRIVATE_MEMORY_READ)
                        .map_err(|_| "invalid_policy")?,
                    Capability::new(capabilities::PRIVATE_MEMORY_WRITE)
                        .map_err(|_| "invalid_policy")?,
                    Capability::new(capabilities::PRIVATE_FILES_READ)
                        .map_err(|_| "invalid_policy")?,
                    Capability::new(capabilities::SETTINGS_MODIFY).map_err(|_| "invalid_policy")?,
                    Capability::new(capabilities::DEVICE_CONTROL).map_err(|_| "invalid_policy")?,
                    Capability::new(capabilities::OWNER_PROFILE_MODIFY)
                        .map_err(|_| "invalid_policy")?,
                ],
            )
            .map_err(|_| "enrollment_rejected".to_owned())?;
        Ok("locked".to_owned())
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeRestoreDevice(
    mut env: JNIEnv, _class: JClass, device_id: JString, platform: JString, public_key: JByteArray,
) -> jstring {
    let result = (|| {
        let device_id = read_string(&mut env, &device_id)?;
        let platform = read_platform(&read_string(&mut env, &platform)?)?;
        let public_key = env.convert_byte_array(public_key).map_err(|_| "invalid_public_key")?;
        authority().lock().map_err(|_| "authority_unavailable".to_owned())?
            .restore_trusted_device(DeviceId(device_id), DeviceCredentialRegistration { platform, public_key })
            .map(|_| "restored".to_owned()).map_err(|e| format!("registry_rejected:{e:?}"))
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeRestoreRevokedDevice(
    mut env: JNIEnv, _class: JClass, device_id: JString, platform: JString, public_key: JByteArray,
) -> jstring {
    let result = (|| {
        let device_id = read_string(&mut env, &device_id)?;
        let platform = read_platform(&read_string(&mut env, &platform)?)?;
        let public_key = env.convert_byte_array(public_key).map_err(|_| "invalid_public_key")?;
        authority().lock().map_err(|_| "authority_unavailable".to_owned())?
            .restore_revoked_device(DeviceId(device_id), DeviceCredentialRegistration { platform, public_key })
            .map(|_| "revoked".to_owned()).map_err(|e| format!("registry_rejected:{e:?}"))
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeRevokeDevice(
    mut env: JNIEnv, _class: JClass, session_id: JString, device_id: JString,
) -> jstring {
    let result = (|| {
        let session_id = read_string(&mut env, &session_id)?;
        let device_id = read_string(&mut env, &device_id)?;
        let mut engine = authority().lock().map_err(|_| "authority_unavailable".to_owned())?;
        let command = CommandRequest {
            origin: CommandOrigin::UserInput,
            capability: Capability::new(capabilities::OWNER_PROFILE_MODIFY)
                .map_err(|_| "invalid_capability")?,
            target: device_id.clone(),
            risk: Risk::Low,
            requires_confirmation: false,
        };
        let decision = engine.authorize(&session_id, &command, Instant::now());
        if !matches!(decision.decision, crate::AuthorizationDecision::Allow) {
            return Err(format!("authorization_denied:{}", decision.reason));
        }
        engine.revoke_device(&DeviceId(device_id))
            .map(|_| "revoked".to_owned()).map_err(|e| format!("device_revocation_rejected:{e:?}"))
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeRestoreRecoveryKey(
    mut env: JNIEnv, _class: JClass, public_key: JByteArray,
) -> jstring {
    let result = env.convert_byte_array(public_key).map_err(|_| "invalid_public_key".to_owned())
        .and_then(|public_key| authority().lock().map_err(|_| "authority_unavailable".to_owned())?
            .restore_recovery_public_key(public_key).map(|_| "restored".to_owned())
            .map_err(|e| format!("registry_rejected:{e:?}")));
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeBootstrapRecoveryIdentity(
    mut env: JNIEnv, _class: JClass, owner_id: JString, public_key: JByteArray,
) -> jstring {
    let result = (|| {
        let owner_id = read_string(&mut env, &owner_id)?;
        let public_key = env.convert_byte_array(public_key).map_err(|_| "invalid_public_key".to_owned())?;
        authority().lock().map_err(|_| "authority_unavailable".to_owned())?
            .bootstrap_recovery_identity(OwnerId(owner_id), public_key)
            .map(|_| "bootstrapped".to_owned()).map_err(|e| format!("recovery_bootstrap_rejected:{e:?}"))
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeSetRecoveryKey(
    mut env: JNIEnv, _class: JClass, session_id: JString, public_key: JByteArray,
) -> jstring {
    let result = (|| {
        let session_id = read_string(&mut env, &session_id)?;
        let public_key = env.convert_byte_array(public_key).map_err(|_| "invalid_public_key")?;
        authority().lock().map_err(|_| "authority_unavailable".to_owned())?
            .set_recovery_public_key(&session_id, public_key, Instant::now())
            .map(|_| "saved".to_owned()).map_err(|e| format!("recovery_key_rejected:{e:?}"))
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeBeginDevicePairing(
    mut env: JNIEnv, _class: JClass, session_id: JString, target_device_id: JString,
    platform: JString, public_key: JByteArray,
) -> jstring {
    let result = (|| {
        let session_id = read_string(&mut env, &session_id)?;
        let target_device_id = read_string(&mut env, &target_device_id)?;
        let platform = read_platform(&read_string(&mut env, &platform)?)?;
        let public_key = env.convert_byte_array(public_key).map_err(|_| "invalid_public_key")?;
        let challenge = authority().lock().map_err(|_| "authority_unavailable".to_owned())?
            .begin_device_pairing(&session_id, DeviceId(target_device_id), platform, public_key)
            .map_err(|e| format!("pairing_rejected:{e:?}"))?;
        serde_json::to_string(&serde_json::json!({
            "challengeId": challenge.challenge_id,
            "ownerId": challenge.owner_id.0,
            "sourceDeviceId": challenge.source_device_id.0,
            "targetDeviceId": challenge.target_device_id.0,
            "platform": platform_name(challenge.target_platform),
            "targetPublicKey": hex(&challenge.target_public_key),
            "challenge": hex(&challenge.bytes),
            "nonce": hex(&challenge_nonce(&challenge.bytes)),
            "expiresInSeconds": 120
        })).map_err(|_| "encoding_failed".to_owned())
    })();
    result_string(&mut env, result)
}

fn challenge_nonce(bytes: &[u8]) -> Vec<u8> {
    // Pairing challenge fields are length-prefixed. Walk to the final field (the random nonce)
    // rather than trying to derive it from IDs or accepting a nonce from a caller.
    let mut offset = b"miss-minutes-device-pair-v1\0".len();
    for _ in 0..7 {
        if offset + 4 > bytes.len() { return Vec::new(); }
        let length = u32::from_be_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]]) as usize;
        offset += 4;
        if offset + length > bytes.len() { return Vec::new(); }
        if offset + length == bytes.len() { return bytes[offset..].to_vec(); }
        offset += length;
    }
    Vec::new()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeCancelDevicePairing(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = authority().lock().map_err(|_| "authority_unavailable".to_owned()).map(|mut engine| {
        engine.cancel_device_pairing();
        "cancelled".to_owned()
    });
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeCompleteDevicePairing(
    mut env: JNIEnv, _class: JClass, challenge_id: JString, signature: JByteArray,
) -> jstring {
    let result = (|| {
        let challenge_id = read_string(&mut env, &challenge_id)?;
        let signature = env.convert_byte_array(signature).map_err(|_| "invalid_signature")?;
        authority().lock().map_err(|_| "authority_unavailable".to_owned())?
            .complete_device_pairing_with_signature(&challenge_id, &signature)
            .map(|device_id| device_id.0).map_err(|e| format!("pairing_rejected:{e:?}"))
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeBeginDeviceRecovery(
    mut env: JNIEnv, _class: JClass, target_device_id: JString, platform: JString, public_key: JByteArray,
) -> jstring {
    let result = (|| {
        let target_device_id = read_string(&mut env, &target_device_id)?;
        let platform = read_platform(&read_string(&mut env, &platform)?)?;
        let public_key = env.convert_byte_array(public_key).map_err(|_| "invalid_public_key")?;
        let challenge = authority().lock().map_err(|_| "authority_unavailable".to_owned())?
            .begin_device_recovery(DeviceId(target_device_id), platform, public_key)
            .map_err(|e| format!("recovery_rejected:{e:?}"))?;
        serde_json::to_string(&serde_json::json!({
            "challengeId": challenge.challenge_id,
            "ownerId": challenge.owner_id.0,
            "targetDeviceId": challenge.target_device_id.0,
            "platform": platform_name(challenge.target_platform),
            "targetPublicKey": hex(&challenge.target_public_key),
            "challenge": hex(&challenge.bytes),
            "expiresInSeconds": 120
        })).map_err(|_| "encoding_failed".to_owned())
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeCompleteDeviceRecovery(
    mut env: JNIEnv, _class: JClass, challenge_id: JString, signature: JByteArray,
) -> jstring {
    let result = (|| {
        let challenge_id = read_string(&mut env, &challenge_id)?;
        let signature = env.convert_byte_array(signature).map_err(|_| "invalid_signature")?;
        authority().lock().map_err(|_| "authority_unavailable".to_owned())?
            .complete_device_recovery(&challenge_id, &signature)
            .map(|device_id| device_id.0).map_err(|e| format!("recovery_rejected:{e:?}"))
    })();
    result_string(&mut env, result)
}

fn platform_name(platform: DevicePlatform) -> &'static str {
    match platform { DevicePlatform::Android => "android", DevicePlatform::Windows => "windows", DevicePlatform::Linux => "linux" }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeCandidate(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = authority()
        .lock()
        .map_err(|_| "authority_unavailable".to_owned())
        .and_then(|mut engine| {
            engine
                .observe_owner_candidate(RecognitionSignal::Presence)
                .map(|_| "owner_candidate".to_owned())
                .map_err(|_| "candidate_rejected".to_owned())
        });
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeObserveFaceMatch(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = authority()
        .lock()
        .map_err(|_| "authority_unavailable".to_owned())
        .and_then(|mut engine| {
            engine
                .observe_owner_candidate(RecognitionSignal::FaceMatch)
                .map(|_| "owner_candidate".to_owned())
                .map_err(|_| "candidate_rejected".to_owned())
        });
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeObserveVoiceMatch(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = authority()
        .lock()
        .map_err(|_| "authority_unavailable".to_owned())
        .and_then(|mut engine| {
            engine
                .observe_owner_candidate(RecognitionSignal::VoiceMatch)
                .map(|_| "owner_candidate".to_owned())
                .map_err(|_| "candidate_rejected".to_owned())
        });
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeBeginAuthentication(
    mut env: JNIEnv,
    _class: JClass,
    device_id: JString,
) -> jstring {
    let result = read_string(&mut env, &device_id).and_then(|device_id| {
        let mut engine = authority()
            .lock()
            .map_err(|_| "authority_unavailable".to_owned())?;
        let challenge = engine
            .begin_authentication(&DeviceId(device_id))
            .map_err(|_| "authentication_unavailable".to_owned())?;
        let mut encoded = String::with_capacity(challenge.bytes.len() * 2);
        for byte in challenge.bytes {
            use std::fmt::Write;
            write!(&mut encoded, "{byte:02x}").map_err(|_| "encoding_failed".to_owned())?;
        }
        Ok(format!("{}\n{encoded}", challenge.challenge_id))
    });
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeCancelAuthentication(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = authority()
        .lock()
        .map_err(|_| "authority_unavailable".to_owned())
        .and_then(|mut engine| {
            engine
                .cancel_authentication()
                .map(|_| "cancelled".to_owned())
                .map_err(|_| "no_pending_authentication".to_owned())
        });
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeCompleteAuthentication(
    mut env: JNIEnv,
    _class: JClass,
    challenge_id: JString,
    signature: JByteArray,
    hardware_backed: jboolean,
) -> jstring {
    let result = (|| {
        let challenge_id = read_string(&mut env, &challenge_id)?;
        let signature = env
            .convert_byte_array(signature)
            .map_err(|_| "invalid_signature".to_owned())?;
        let assurance = if hardware_backed != 0 {
            AuthenticationAssurance::HardwareBackedPlatformUserVerification
        } else {
            AuthenticationAssurance::PlatformUserVerification
        };
        let mut engine = authority()
            .lock()
            .map_err(|_| "authority_unavailable".to_owned())?;
        engine
            .complete_owner_authentication(
                &challenge_id,
                &signature,
                assurance,
                Duration::from_secs(30 * 60),
            )
            .map(|session| session.session_id)
            .map_err(|_| "authentication_rejected".to_owned())
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeStartGuest(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = authority()
        .lock()
        .map_err(|_| "authority_unavailable".to_owned())
        .and_then(|mut engine| {
            engine
                .start_guest_session(Duration::from_secs(12 * 60 * 60))
                .map(|session| session.session_id)
                .map_err(|_| "guest_session_unavailable".to_owned())
        });
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeAuthorize(
    mut env: JNIEnv,
    _class: JClass,
    session_id: JString,
    command_json: JString,
) -> jstring {
    let result = (|| {
        let session_id = read_string(&mut env, &session_id)?;
        let command_json = read_string(&mut env, &command_json)?;
        let mut command: CommandRequest =
            serde_json::from_str(&command_json).map_err(|_| "invalid_command".to_owned())?;
        // Capability validation is repeated at the boundary, including for JNI callers.
        command.capability =
            Capability::new(command.capability.0).map_err(|_| "invalid_command".to_owned())?;
        let mut engine = authority()
            .lock()
            .map_err(|_| "authority_unavailable".to_owned())?;
        let decision = engine.authorize(&session_id, &command, Instant::now());
        serde_json::to_string(&decision).map_err(|_| "decision_encoding_failed".to_owned())
    })();
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeLock(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = authority()
        .lock()
        .map_err(|_| "authority_unavailable".to_owned())
        .map(|mut engine| {
            engine.lock();
            "locked".to_owned()
        });
    result_string(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeOwnerSessionActive(
    mut env: JNIEnv,
    _class: JClass,
    session_id: JString,
) -> jboolean {
    let result = read_string(&mut env, &session_id)
        .ok()
        .and_then(|session_id| {
            authority().lock().ok().map(|mut engine| {
                let active = engine.owner_session_active(&session_id, Instant::now());
                if !active {
                    engine.lock();
                }
                active
            })
        })
        .unwrap_or(false);
    if result { 1 } else { 0 }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeRequireStepUp(
    mut env: JNIEnv,
    _class: JClass,
    session_id: JString,
) -> jboolean {
    let result = read_string(&mut env, &session_id)
        .ok()
        .and_then(|session_id| {
            authority()
                .lock()
                .ok()
                .map(|mut engine| engine.require_step_up(&session_id, Instant::now()))
        })
        .unwrap_or(false);
    if result { 1 } else { 0 }
}

/// Returns the current `AuthState` as a snake_case string so the UI can display the right
/// authority status pill without exposing private session IDs or capability details.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_patel5600_missminute_mobile_app_OwnerAuthority_nativeGetAuthState(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = authority()
        .lock()
        .map_err(|_| "authority_unavailable".to_owned())
        .map(|engine| {
            match engine.state() {
                crate::AuthState::Unenrolled           => "unenrolled",
                crate::AuthState::Locked               => "locked",
                crate::AuthState::OwnerCandidate        => "owner_candidate",
                crate::AuthState::AuthenticationPending => "authentication_pending",
                crate::AuthState::OwnerAuthenticated    => "owner_authenticated",
                crate::AuthState::StepUpRequired        => "step_up_required",
                crate::AuthState::GuestActive           => "guest_active",
                crate::AuthState::Revoked               => "revoked",
                crate::AuthState::DeviceUntrusted       => "device_untrusted",
            }
            .to_owned()
        });
    result_string(&mut env, result)
}

#[cfg(test)]
mod tests {
    use super::challenge_nonce;
    use crate::{AuthorizationDecision, AuthorizationResult, CommandRequest};

    #[test]
    fn pairing_nonce_is_the_final_length_prefixed_challenge_field() {
        let mut challenge = b"miss-minutes-device-pair-v1\0".to_vec();
        for field in [b"owner".as_slice(), b"source", b"target", b"android", &[4; 65], b"challenge-id", &[9; 32]] {
            challenge.extend_from_slice(&(field.len() as u32).to_be_bytes());
            challenge.extend_from_slice(field);
        }
        assert_eq!(challenge_nonce(&challenge), vec![9; 32]);
    }

    #[test]
    fn android_command_json_uses_the_rust_authorization_contract() {
        let command: CommandRequest = serde_json::from_str(
            r#"{"origin":"user_input","capability":"settings.modify","target":"","risk":"low","requires_confirmation":false}"#,
        )
        .unwrap();
        assert_eq!(command.capability.0, "settings.modify");
        assert_eq!(command.origin, crate::CommandOrigin::UserInput);
        assert_eq!(command.risk, crate::Risk::Low);

        let encoded = serde_json::to_string(&AuthorizationResult {
            decision: AuthorizationDecision::Allow,
            reason: "allowed",
        })
        .unwrap();
        assert_eq!(encoded, r#"{"decision":"allow","reason":"allowed"}"#);
    }
}
