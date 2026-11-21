# Owner Identity Implementation Status

## Current trust path

The shared policy and session engine is in `native/identity`. Android calls it only through
`OwnerAuthority` JNI methods; those methods are not exposed through the WebView bridge. The Android
owner key is generated in Android Keystore, requires strong biometric or supported device-credential
verification for signing, and must report hardware-backed storage before enrollment or pairing proceeds. Rust accepts a
signed, short-lived challenge before it creates an owner session or trusts a paired device.

Android face matching and speaker matching run locally and can report an owner candidate. They do
not create an owner session. The Android device credential plus BiometricPrompt remains the
authority anchor. Speaker templates are encrypted with an Android Keystore AES-GCM key and stay on
the enrolling device; raw enrollment and check audio is discarded after embedding extraction. The
speaker cutoff is provisional, replay resistance is not established, and neither sensor has physical
false-accept/false-reject calibration in this environment.

## Android and Windows-to-Android pairing

1. The new Android phone creates a random device ID and a Keystore-backed P-256 key. It exports a
   versioned request containing only the ID, platform, and public key.
2. An enrolled Android phone or Windows desktop validates the request and asks Rust to create a
   one-use challenge bound to the owner ID, source device, target device, platform, and target
   public key.
3. Android's BiometricPrompt-gated Keystore key signs the challenge. Windows uses a platform
   WebAuthn assertion with user verification. Rust verifies the source proof and rechecks that the
   initiating owner session is still live when the challenge is committed.
4. The source stores the new public credential in its protected local registry and returns a signed
   receipt. The Windows receipt includes the WebAuthn assertion for independent verification by
   the target Android device.
5. The new phone checks that the receipt targets its pending ID and exact local public key, rebuilds
   the signed challenge fields, verifies the source signature/assertion and compares a short source
   key fingerprint with the code shown on the Windows desktop, then initializes the same owner ID.
   The new phone's private key never leaves Android Keystore.

Transfer is currently a manual text exchange in Settings. The payload contains public keys and a
signature/assertion, not biometric data, private keys, memory, or provider secrets. Treat it as
sensitive pairing material and exchange it directly between devices. For Windows-to-Android
pairing, compare the displayed fingerprint on both screens before importing; a valid signature
proves control of the source credential, while the comparison binds the ceremony to the intended
desktop. The source device ID remains visible as a secondary check. There is no unattended or
internet-relayed pairing protocol.

## Android first-run staged enrollment

The dashboard guides first launch through explicit sensor disclosure, local face enrollment,
local speaker enrollment, optional foreground gaze calibration, and finally the platform credential
that activates the initial owner claim. Face and speaker templates are encrypted with device-local
Android Keystore AES-GCM keys and stored as pending records. Matching only loads active records;
the native setup handler promotes staged templates after a valid Rust owner session exists. Canceling
device verification leaves the profiles encrypted and inactive, so a guest cannot use them to unlock
owner data. Skipping face, voice, or gaze only skips that onboarding step; it does not create a
profile or grant a capability.

The explicit consent screen says these profiles are optional and local, and that this app does not
currently run a background microphone or camera session. Camera and microphone permissions are
requested by their individual foreground enrollment screens. Gaze calibration currently lasts only
for the foreground presence session and is not persisted across app restarts.

On Android 11 and later, the device signing key and platform prompt allow either a strong biometric
or the device PIN, pattern, or password. Earlier supported Android versions use a strong biometric
prompt for the cryptographic operation. A device without a supported authenticator cannot finish
this Android owner-enrollment path; recovery and external authenticators are separate paths.

## Regressions covered

- Rust tests verify normal pairing, wrong signatures, replay/expiry behavior, and rejection after
  the initiating session is revoked while a biometric prompt is pending.
- Android's protocol vocabulary marks the pairing commands as user-only dashboard operations.
- Android unit tests check the stable protocol table.

## Offline Android recovery kit

An enrolled Android owner can create an offline recovery kit from Settings after a fresh
BiometricPrompt-gated signature. A random P-256 recovery key is generated locally; the private key
is encrypted into a portable JSON kit with AES-256-GCM and a PBKDF2-HMAC-SHA256 passphrase key
(600,000 iterations). The encrypted kit is returned once to the dashboard and is not written to
app storage. The matching public key is stored in the encrypted Android Keystore-backed registry
and Rust authority. Keep the kit offline and store its passphrase separately. Replacing the
recovery key invalidates the old kit.

On a clean replacement Android install, the owner supplies both values. The app verifies the
passphrase and keypair, generates a new hardware-protected Android device key, bootstraps only the
owner ID and recovery verifier, then signs a Rust-generated one-use challenge with the recovered
key. Only a valid proof registers the new device. Recovery does not transfer private data,
biometric templates, provider secrets, active sessions, or other device keys. The replacement
device remains locked and must complete normal device authentication before owner capabilities are
available. Passphrase derivation runs off the UI thread.

The same kit can enroll a replacement Windows desktop. Windows creates a new platform WebAuthn
credential for the recovered owner ID, the Rust engine verifies a one-use recovery signature, and
the new credential is sealed in the desktop's OS-protected owner registry. The desktop remains
locked until Windows Hello authenticates the new device. This path has not been physically tested.
Recovery passphrases are restricted to 12–256 printable ASCII characters so Android's PBKDF2 output
is byte-for-byte interoperable with the Windows implementation.

## Android trusted-device revocation

An enrolled owner can view locally registered device IDs and revoke another listed device from the
Owner & devices screen. The action invalidates the current session, requires fresh Android Keystore
verification through BiometricPrompt, then asks the Rust policy engine to authorize
`owner.profile.modify` before revoking that device credential and its sessions. The revoked marker
is committed to the encrypted Android registry; app startup restores it into Rust as revoked, so
this device's authority engine will reject it after restart. The current device cannot revoke itself
through this screen.

This is local revocation only. There is no authenticated revocation-list exchange protocol yet, so
offline Android or desktop peers do not learn about it automatically. Revoke a lost device on every
reachable trusted device. Do not treat local revocation as cross-device emergency revocation.

## Android WebView owner-data boundary

The legacy browser database is origin-scoped to `https://appassets.androidplatform.net` and is now
loaded only by the migration renderer. The dashboard and floating overlay use separate virtual
origins (`dashboard.missminutes.local` and `overlay.missminutes.local`), so the legacy IndexedDB
cannot be reached from their origin. The dashboard/overlay hide IndexedDB from their document
global as defense in depth. Their Content Security Policy blocks worker creation and direct network
requests. Android cloud-provider requests go through native handlers; owner records and credentials
use the authenticated bridge and encrypted SQLCipher store. The migration renderer is still opened
only after an owner-authenticated migration request.

The Android bridge applies a central default-deny session check to Dashboard and USER_ONLY
commands. Its locked-state onboarding allowlist permits only consent capture, initial owner
enrollment, and local profile/presence screens. Each handler rechecks consent and enrollment state;
face and speaker profiles remain pending until successful device authentication. Signed pairing
and recovery bootstrap, status, and stop/cancel operations retain their own validation. A regression test checks the entire
message table so newly added commands require a session by default. Each handler still applies its
specific capability or signature validation. `USER_ONLY` restricts a command to the Dashboard
renderer; it is not evidence of a physical tap. Other router construction defaults to
unauthenticated.

Android native provider requests and ChatGPT proxy work are bound to the owner session that started
them. Lock or session expiry cancels tracked network operations; late results are discarded and a
newly authenticated session cannot adopt work from the previous session. The migration WebView
rechecks the Rust memory capability on each migration-store operation, in addition to its isolated
origin and short-lived activity lifecycle.

Android WebView has no reliable supported switch to turn off IndexedDB for just one renderer, so
the storage boundary relies on origin isolation plus not placing owner data in renderer databases.
New persistent browser data should not be added to app renderers; any exceptional browser
persistence needs a separate explicitly designed store.

## Not implemented or not physically validated

- Offline recovery is implemented for Android-to-Android replacement using an owner-held encrypted
  recovery kit. It has not been exercised in a physical two-device recovery ceremony in this build
  environment.
- Windows-to-Android pairing is implemented in source and has a local cryptographic verifier test,
  but the Windows Hello ceremony and cross-device transfer have not been physically exercised.
- Desktop recovery-kit creation is not implemented; a Windows desktop can import an Android kit.
- Linux FIDO2 pairing and recovery are not implemented.
- Revocation synchronization between offline devices is not implemented. A lost device may remain
  locally trusted until each reachable device receives a revocation update; the offline recovery
  kit alone cannot revoke a disconnected device. Recovery-kit rotation changes the recovery
  verifier only on the device where rotation is performed until that state is synchronized.
- No connected Android device was available for a physical pairing ceremony, biometric prompt,
  sensor, latency, or failure-recovery validation in this build environment.
- Android `VoiceInteractionService`/system hotword integration is not implemented. Current Android
  voice enrollment and recognition are foreground, user-initiated flows; do not claim always-on
  listening or background wake-phrase support. The selected system voice-interaction service is the
  supported Android route to investigate and requires user selection and device/platform validation.
- Android speaker matching now has a sherpa-onnx runtime, WeSpeaker English VoxCeleb ResNet34 model,
  encrypted local enrollment, foreground recording and candidate-only Rust signal. It compiles into
  the APK and its vector comparison has unit tests. It has not been run on a physical device; capture,
  model initialization, latency, matching threshold, replay behavior and owner/guest error rates are
  unvalidated. Do not use it as authorization or claim it is instant or perfect.
- Face matching is a candidate signal. Liveness/false-accept performance has not been validated
  against presentation attacks or across the required lighting, distance, occlusion, and multi-face
  conditions. It must not be described as perfect or used to authorize owner capabilities.
- The gaze-to-verification path previously stopped receiving confirmed-face events after the first
  candidate, so its calibrated dwell could not complete. The consensus gate now exposes whether
  fresh matching frames continue to support that candidate; an authority-core rejection resets the
  evidence. Unit coverage exercises continued confirmation and invalidation. This enables gaze to
  request Android verification after the configured dwell; it does not grant owner authority, and
  the gaze calibration and false-activation rate still require physical-device validation.
- Android speaker matching now clears decrypted enrolled embeddings and temporary enrollment
  templates after use. The matcher remains candidate-only and its current UI explicitly discloses
  that replay resistance has not been validated.
- Windows desktop authentication source exists but its physical Windows Hello ceremony and complete
  pairing/recovery path have not been validated here. Linux FIDO2 integration is also outstanding.
- Desktop action approval now uses each stored proposal's risk in the Rust authority path; high or
  critical actions require fresh Windows Hello after the native confirmation dialog. The source
  parses successfully, but a Windows-target type-check and runtime ceremony remain unverified.

These constraints are release blockers for claiming production owner authorization across all
platforms.
