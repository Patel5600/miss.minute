# Miss Minutes identity core

This crate contains shared identity state, device-credential signature checks, sessions, pairing,
recovery challenge primitives and authorization policy. Android builds it as a JNI shared library;
the Android adapter uses Keystore/BiometricPrompt. The Windows desktop adapter uses native
WebAuthn/Windows Hello. Platform adapters must protect persistent registries and enforce this
policy at every private-data and privileged-command entry point.

## Current authentication boundary

1. Android's explicit first-device setup creates an auth-per-use P-256 key in Android Keystore,
   requires `BiometricPrompt` for signing, rejects a key that Android does not report as
   hardware-backed, and records only owner/device IDs in app-private preferences. Startup
   rehydrates the Rust in-memory registry from protected local state. Windows enrolls a WebAuthn
   platform credential and stores its registry sealed by the OS-protected local key.
2. Face, voice and presence observations can only mark `OwnerCandidate`.
3. Android starts a native system biometric prompt with a Keystore `Signature` crypto object and
   signs the domain-separated challenge after verification. The challenge is one-use and expires
   after 60 seconds. Android versions before API 28 fail closed.
4. Rust verifies the P-256/SHA-256 ECDSA signature and creates a monotonic owner session. JNI
   exports the native adapter path; no WebView bridge message exposes it. The session remains in
   process memory and is locked when the dashboard stops or the app kill action runs.

Android gates dashboard/overlay bridge messages, private store/provider handlers, selected native
settings, permissions and overlay controls through a live Rust owner session. The dashboard and
overlay use isolated origins; only the migration renderer can access legacy browser data. Desktop
uses WebAuthn/Windows Hello for authentication and native tool authorization. Android-to-Android
pairing/recovery and Windows-to-Android manual pairing have platform adapters; desktop recovery,
Linux FIDO2, synchronized revocation and full cross-device policy synchronization remain absent.
Face/gaze are separate local candidate/interaction signals. Android now bundles the sherpa-onnx
speaker embedding runtime and WeSpeaker English VoxCeleb ResNet34 model. Three foreground samples
produce an encrypted device-local template; a foreground voice check compares a fresh local sample
and can only mark `OwnerCandidate`. Android biometric/device-key authentication is still required.
The initial similarity threshold is provisional and has not been calibrated on physical owner and
guest recordings. Replay resistance is not established. The Rust crate itself does not process
camera or audio data.

## Policy behavior

- Guests receive only the three capabilities in `capabilities::guest_allowlist()`.
- Owner capabilities are fixed at enrollment for the lifetime of the in-memory engine.
- Sessions use monotonic `Instant` timestamps, expire within 30 minutes for owners and 12 hours
  for guests, and can be explicitly locked or revoked.
- High-risk commands require confirmation. Critical commands require confirmation and require a
  new authentication challenge when the owner session is more than 30 seconds old.
- External/model/plugin origins cannot change the session principal or expand the capability set.

Run the policy and cryptographic tests with `cargo test -p miss-minute-identity` from the
repository root. Gradle's `buildAndroidIdentity` task builds the `cdylib` for Android ABIs through
`cargo-ndk`. Builds and core tests do not replace physical-device biometric, hardware-backed
Keystore, lifecycle, privacy, or app-wide authorization validation.
