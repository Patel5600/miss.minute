# Miss Minutes desktop companion

The desktop host is a Tauri 2 application. It embeds the existing React interface, creates a separate transparent always-on-top avatar window, owns the local IPC boundary, registers login startup, and creates a native system-tray menu.

## Windows behavior

- The avatar is a separate desktop-sized transparent window, not an element trapped inside the dashboard.
- The SVG character continues its 60 FPS delta-time movement, eye tracking, blinking, rubber-hose limb animation, drag physics, and speech-reactive mouth animation.
- A native hit-test loop checks the global pointer against the character's current bounds. Windows receives pointer events only around the character; the transparent overlay passes clicks through elsewhere. While dragging, the overlay remains interactive even when the pointer moves outside the last published avatar rectangle.
- The dashboard can be closed while the companion, tray icon and enrolled local agent stay alive.
- The tray can reopen the dashboard, show or hide the avatar, stop the local agent, or quit.
- Login startup is opt-in and uses the Tauri autostart plugin. Startup launches in background mode, restores the avatar and restarts an existing enrolled worker.
- Dashboard responses are sent to the avatar using a native Tauri event. The overlay performs TTS and drives the mouth animation from its own audio analyser or speech-boundary events. Native mode does not run the old random spoken chatter timer.

## Browser-to-agent IPC

The embedded UI calls registered Tauri commands through the Tauri IPC bridge. There is no unauthenticated localhost HTTP listener and no browser page exposed as a network service.

The bridge exposes:
- agent_enroll: create owner-confirmed configuration for explicitly supplied absolute folder paths.
- agent_status: read the enrolled roots and local store counters.
- agent_start / agent_stop: supervise the Rust collector in a managed worker thread.
- agent_recent_decisions: read stored model decisions.
- avatar_speak: send a typed speech event, emotion, and voice parameters to the avatar window.
- set_avatar_bounds / set_avatar_dragging: report the animated character's current bounds and drag state to Windows hit-testing.
- set_startup / get_startup: configure and inspect login startup.
- toggle_avatar / show_dashboard: native window controls.

The Rust collector accepts an external shutdown token. The Tauri host does not install a process-global Ctrl+C handler.

## Privacy and safety limits

The existing agent's scope is unchanged: explicit directory allowlists, filesystem metadata only, no file content reads, no symlink traversal, no keystrokes, clipboard, screenshots, browser history, or private application databases. Remote reasoning stays disabled until explicitly configured and approved in the agent configuration.

The task executor is NOT enabled in this milestone. The current model proposal schema contains only a free-form kind and description, not a typed, validated tool payload. The next phase must add a typed capability registry, durable pending-action queue, per-capability scopes, idempotency, dry-run previews, revocation, and audit records before any action can execute. There is no shell-command executor. The local filesystem reasoner's speak candidates are not yet forwarded into the avatar event stream.

## Platform status

- Windows: system tray, startup registration, full-screen transparent overlay with cursor pass-through outside the avatar.
- macOS and Linux: Tauri shell, tray and startup APIs are available, but this milestone uses a compact overlay window because equivalent precise click-through hit testing has not been implemented there.
- Android and iOS: no native companion agent is shipped. Mobile requires platform-specific foreground/background execution, permission and lifecycle design. The desktop worker is not a mobile background service.

## Build on Windows

Install Rust stable 1.90 or newer and the Tauri CLI:

    cargo install tauri-cli --locked
    cd native/desktop/src-tauri
    cargo tauri dev

For a production package:

    cargo tauri build

The Tauri config runs the root Vite build and uses the root dist directory. The Windows GitHub Actions workflow checks the React build and compiles the desktop host. The Windows bundle uses the TVA clock icon in the Tauri icons directory.

## Native enrollment

Open the dashboard in the desktop application. In Desktop Companion, enter one existing absolute directory path per line, review the scope, and explicitly confirm metadata-only monitoring. The app creates its configuration under the OS app-data directory and starts the worker.

The first version intentionally does not provide automatic broad home-directory, drive-root, or profile enrollment.


## Typed action approval surface

The dashboard can authorize an exact note-output folder separately from metadata collection. Pending proposals show the full Markdown body and exact target path. The owner can approve once or reject. Revoking the folder permission expires pending proposals. See the agent README for CLI equivalents and strict execution limits.


## Background reasoner speech

When the local reasoner returns a validated speak decision, the Rust worker forwards the text to the separate avatar webview using a Tauri event. The same voice-reactive SVG renderer animates the mouth from the overlay playback analyser or speech-boundary callbacks. Silent decisions remain silent; action proposals stay in the dashboard approval queue.


## Bounded automatic note creation

The dashboard exposes an explicit Automatic note creation switch. It is off by default, requires an approved note-output folder, and only enables the typed create_note capability. The hard quota is three successful note creations per UTC day. The UI displays the quota count. Disabling or enabling the policy restarts the worker with the updated config; revoking a note folder also stops the worker, expires pending proposals, and restarts with the revoked scope.
