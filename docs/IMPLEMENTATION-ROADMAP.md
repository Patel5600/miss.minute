# Miss Minutes implementation roadmap

This roadmap distinguishes implemented code from release validation and unfinished capabilities. It does not treat a successful compile as proof of runtime behavior.

## Release 1 — Persistent desktop shell

### Implemented in code

- Tauri 2 host around the React/Vite interface.
- Windows transparent, always-on-top avatar overlay with pointer pass-through outside the animated character and drag-state handling.
- Windows tray controls and opt-in login startup.
- Managed Rust worker with explicit shutdown and restart on policy changes.
- Typed Tauri command IPC. The dashboard receives the full local control surface; the avatar receives only its bounds and drag-state commands.
- Native speech events to the overlay renderer, including mouth animation tied to speech playback.
- Windows release executable build and artifact workflow, with optional certificate signing and provenance attestation.

### Release gates still open

- Successful Windows Tauri compilation, native-agent tests and release executable artifact upload on the latest branch revision.
- Real Windows desktop smoke testing: pointer pass-through, character hit-testing, dragging, speech, tray, login startup, multi-monitor DPI and sleep/resume.
- Certificate-backed signing with owner-provided signing material. Without it, artifacts are unsigned and must be labeled as such.

A hosted CI runner cannot substitute for testing the actual user's display drivers, DPI settings, audio devices and login environment.

## Release 2 — Local context and event delivery

### Implemented in code

- A versioned local evidence ledger with event IDs, source, event type, observed timestamp, source timestamp semantics, path and payload.
- Authenticated local Tauri event reads using a random per-session token, 30-minute expiry, bounded pages, durable cursor and explicit acknowledgements.
- Repeatable unacknowledged pages, renderer sequence deduplication and explicit retention-gap errors.
- Owner-approved Windows foreground-window-title capture, disabled by default and recording title changes only.
- Owner-pinned context notes, encrypted with the local evidence database, with 20-note and 64 KiB aggregate bounds. The owner can add, enable, disable and delete notes.
- The reasoner receives pinned notes as untrusted background context, separate from observed event evidence.

### Still required

1. Cross-device authenticated pairing and event synchronization for Android/iOS.
2. A formal versioned transport envelope with device identity, replay protection, per-device revocation and explicit source grants.
3. More context connectors only after their data scope, provenance, freshness, retention and revocation behavior are specified. Browser tabs should use an explicit extension/native-messaging bridge; no keylogging or silent screen capture.
4. Automated tests for token expiry, duplicate pages, acknowledgement misuse, cursor rollback, retention gaps and source revocation.

The current stream is local authenticated IPC polling, not a remote push service or mobile sync channel.

## Release 3 — Native mobile companions

### Android implemented in code

- Owner-selected Storage Access Framework document tree and persisted URI permission.
- User-started visible foreground service with an ongoing Stop action.
- Bounded metadata traversal (5,000 documents per pass, depth 16).
- SQLCipher-encrypted local snapshots/events with a random database key wrapped by a non-exportable Android Keystore AES-GCM key.
- Event history capped at 10,000 records.

### iOS implemented in code

- SwiftUI companion with owner-selected security-scoped folder.
- Folder bookmark stored in Keychain.
- Opportunistic BackgroundTasks refresh, metadata-only snapshots and events.
- iOS complete file protection for snapshot/event files.

### Still required

- Successful Android API 36 debug APK build and physical device validation.
- Signed iOS device build and physical device validation.
- Android battery/background restrictions and service restart behavior testing.
- iOS background refresh scheduling, stale bookmark recovery and file-protection testing.
- Authenticated mobile-to-desktop pairing and replay-safe synchronization. No mobile data is currently sent to desktop.

iOS cannot provide a continuously running daemon or a floating overlay over unrelated apps. Android foreground service behavior is subject to OS and distribution policy.

## Release 4 — Secure storage and distribution

### Implemented in code

- Desktop and Android SQLCipher databases.
- Desktop database keys in the OS credential vault; Android database key wrapped by Android Keystore AES-256-GCM.
- iOS snapshots/events protected by platform file protection; folder bookmarks in Keychain.
- Desktop provider credentials in the OS credential vault. Persisted web settings omit key values. Gemini API keys are sent in a request header rather than a URL.
- Tauri command permissions are generated from an explicit command registry and assigned by window capability.

### Still required

- Physical migration and recovery testing for existing plaintext desktop databases on Windows/macOS/Linux.
- Key loss, vault unavailability, device restore and database corruption tests on all platforms.
- OS-specific IPC/capability audit, credential redaction and secret-lifetime review.
- Signed Windows and macOS distribution with owner-controlled certificates, protected CI secrets, provenance verification and release checksums.
- Mobile signing, app-store privacy disclosures and platform policy review.

## Release 5 — Safe task execution

### Implemented vertical slice

- One typed create_note capability; no arbitrary commands or scripts.
- Separate owner-approved output folders, exact target/content preview and manual approval.
- Durable one-shot queue, 24-hour expiry, evidence references and append-only audit transitions.
- Exclusive atomic creation; existing files are never overwritten.
- Optional automatic note mode, disabled by default and capped at three successful notes per UTC day.

### Still required for broader execution

- Add narrowly scoped typed capabilities only with a concrete owner permission model, dry-run preview, idempotency, revocation, audit and safe failure semantics.
- No general shell endpoint, arbitrary script execution or unrestricted desktop control.
- Model output remains untrusted and cannot grant itself permissions.
