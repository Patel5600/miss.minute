# Miss Minutes implementation roadmap

This roadmap replaces the old checklist with dependency-ordered releases. It distinguishes code that exists from behavior that still needs platform validation.

## Release 1 — Persistent desktop shell (current branch)

### Delivered in code
- Tauri 2 host around the existing React/Vite UI.
- Typed Tauri command IPC for agent enrollment, status, lifecycle and desktop controls; event IPC for dashboard speech to the avatar.
- Windows transparent, always-on-top avatar window.
- Windows native cursor hit-testing so clicks pass through outside the character, with drag-state handling.
- Windows system tray with dashboard, avatar, agent-stop and quit actions.
- Opt-in login startup; an enrolled agent restarts when the host launches.
- Managed Rust agent worker with explicit shutdown.
- Existing custom SVG movement and speech-reactive mouth renderer reused in the overlay rather than rebuilt as a lower-quality static sprite.

### Release gates
- Frontend production build and lint.
- Root Rust tests and clippy.
- Windows Tauri compile.
- Windows agent tests.
- Release Windows executable build and artifact upload.
- Manual Windows smoke test: launch, close dashboard, click through on other apps, drag the character, play dashboard speech, stop/restart worker, logout/login, multiple display scaling and sleep/resume.

### Known platform limits
- Windows receives the full-screen pass-through overlay path in this milestone.
- macOS/Linux use the compact overlay path and do not yet have equivalent precise click-through hit-testing.
- This branch is a native desktop development milestone; a successful CI build is not a signed installer or proof of runtime behavior on every GPU/display driver.

## Release 2 — Living intelligence and event stream

This must come before autonomous execution. A decision engine cannot safely act on incomplete and ambiguous observations.

1. Define a versioned evidence envelope for every connector: source, owner consent grant, timestamp semantics, confidence, event ID, collection gap, and retention class.
2. Add an authenticated internal event stream from the Rust worker to Tauri. Push only newly committed events and decisions; reconnect by durable event cursor.
3. Add owner-approved context sources one by one: active app/window title, selected browser tabs through an explicit extension/native messaging bridge, and user-created tasks. Do not add keylogging, silent screen capture or clipboard collection.
4. Maintain context as claims with provenance, freshness, and confidence. User corrections must override inference. Old context decays and can be deleted.
5. Give the reasoner an interrupt budget and an attention policy. It can silently defer, ask one useful question, or propose a next step. It must never pretend to know facts not present in evidence.
6. Route reasoner-approved speech events to the avatar event bus. The avatar only animates; it does not invent device observations.

Exit criteria: tests for source spoofing, duplicate events, stale context, permission revocation, reconnect/replay, and fabricated observations. No actions execute in this release.

## Release 3 — Safe task execution

Do not add a shell-command endpoint or allow the model to author arbitrary code. The model chooses from a finite capability registry.

1. Define typed action variants with validated payload schemas (for example: create a note, draft a document, move a file within an approved root, or create a reminder).
2. Bind each capability to an explicit resource scope and user-granted permission. Default is read-only.
3. Require a preview/dry-run containing exact target resources and expected before/after state.
4. Store pending approvals durably, with expiry, idempotency key, origin evidence IDs, and a visible approval surface in the dashboard/tray.
5. Execute one capability at a time under bounded timeouts and resource limits. Never escalate scopes on model request.
6. Record append-only audit events, result hashes, errors and reversibility status.
7. Support cancel/revoke and undo where the operation is reversible. Destructive or external side effects always require fresh approval.

Exit criteria: property tests for payload validation, permission boundaries, idempotency, stale approvals, path traversal, race conditions and failure recovery; end-to-end tests with a fake capability provider; no unrestricted process execution.

## Release 4 — Mobile companions

Mobile is a separate product target, not a compile flag on the desktop daemon.

### Android
- Kotlin foreground service with a persistent user-visible notification when the OS requires it.
- Explicit runtime permissions, battery/background restrictions surfaced to the user, bounded WorkManager jobs for deferred work.
- Compose companion UI and a lightweight avatar that remains inside the app or OS-approved surfaces.
- Rust core shared through JNI only for deterministic local logic and validated evidence envelopes.

### iOS
- SwiftUI companion UI with Rust core through UniFFI/FFI where it is worth the maintenance cost.
- Use only OS-permitted background modes and background tasks. Do not promise an always-running daemon or an unrestricted floating avatar over other apps.
- Use notifications/Live Activities only where the product and OS lifecycle permit them.

### Cross-device trust
- Pairing with explicit user action, device identity, revocation and end-to-end authenticated transport.
- Per-device consent and source scopes; no silent mirroring of all metadata.
- No sync until the local privacy and deletion model is defined.

Exit criteria: platform permission review, lifecycle tests on physical devices, battery impact budget, offline behavior, device revocation and data deletion tests.

## Release 5 — Security and reliability hardening

- Encrypt the local event store at rest with keys held in the OS credential store.
- Move provider credentials out of browser local storage into the platform credential vault; provide migration and rotation.
- Tighten Tauri capabilities per window and command. The avatar window should receive only the events and controls it needs.
- Commit Cargo.lock files for each workspace and use --locked in CI and release builds.
- Add signed installers, update verification, crash recovery, schema migration and backup/deletion semantics.
- Test multiple monitors, high-DPI scaling, sleep/resume, display topology changes and accessibility/reduced-motion behavior.

## Release order

Desktop lifecycle and IPC -> reliable event stream and provenance -> context/attention engine -> typed approved actions -> mobile-native companions -> security hardening and signed distribution.

Android/iOS background restrictions are intentional platform limits. The product must communicate them rather than claim the character can live above every app on every phone.
