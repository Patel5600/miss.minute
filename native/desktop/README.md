# Miss Minutes desktop companion

The desktop host is a Tauri 2 application. It embeds the existing React interface, creates a separate transparent always-on-top avatar window, owns the local IPC boundary, registers login startup, and creates a native system-tray menu.

## Windows behavior

- The avatar is a separate desktop-sized transparent window, not an element trapped inside the dashboard.
- The existing SVG renderer supplies delta-time locomotion, eye tracking, blinking, rubber-hose limbs, waving, walking, drag physics, and speech-reactive mouth movement.
- A native hit-test loop checks the global pointer against the current character bounds. The overlay passes clicks through outside the character and remains interactive while a drag is in progress.
- The dashboard can be hidden while the companion, tray icon and enrolled local agent remain alive.
- The tray can reopen the dashboard, show or hide the avatar, stop the local agent, or quit.
- Login startup is opt-in. Startup launches in background mode, restores the avatar and restarts an existing enrolled worker.
- Dashboard replies and validated local-reasoner speech decisions are sent to the avatar through native Tauri events. The overlay performs TTS and drives mouth movement from its audio analyser or speech-boundary events. Native mode disables the old random spoken-chatter timer.

## Browser-to-agent IPC

The embedded UI calls registered Tauri commands through the Tauri IPC bridge. There is no unauthenticated localhost TCP listener and no shell-command bridge.

The command surface includes:
- agent enrollment, status, start and stop;
- explicit note-output permission grant/revoke;
- pending action listing, exact action approval and rejection;
- opt-in bounded automatic note creation policy;
- startup registration and inspection;
- avatar/dashboard visibility;
- avatar speech events and current bounds/drag state for Windows hit-testing.

The Rust collector accepts an external shutdown token. The Tauri host does not install a process-global Ctrl+C handler. Policy and permission changes stop and join the current worker before restarting it with the new configuration.

## Privacy and evidence limits

The collector reads filesystem metadata only from explicit owner-authorized roots. It does not read file contents, follow symlinks, capture keystrokes, clipboard, screenshots, audio, browser history, or application-private data. Metadata timestamps are not proof of user activity. Filesystem notifications may be coalesced or missed; current scans cannot reconstruct deleted files or all past activity.

The optional reasoner is disabled by default. Local plaintext HTTP is restricted to loopback. Remote reasoning requires HTTPS and explicit consent to send local paths and metadata. API key values are not stored in the Rust agent config. The existing web UI provider keys remain in browser local storage and have not yet been migrated to the OS credential vault.

The SQLite database is local but is not encrypted at rest in this milestone.

## Typed task execution

The model cannot return arbitrary commands or scripts. The only native capability currently implemented is `create_note`:
- the owner separately grants one or more existing subfolders as note-output roots;
- the model can request a new Markdown file only, with an ASCII slug filename and an 8192-byte content limit;
- the owner can inspect the exact target path and complete note body, then approve or reject;
- creation is exclusive and fails if the destination already exists; existing files are never overwritten;
- pending proposals expire after 24 hours, are one-shot, and have durable audit transitions;
- revoking a note-output grant expires pending proposals;
- interrupted executions are marked uncertain/failed and are not automatically retried.

A separate automatic-note-creation switch is off by default. When explicitly enabled, the host may automatically execute only the typed `create_note` capability inside the separately approved note-output roots. It is hard-capped at three successful notes per UTC day. Quota exhaustion leaves proposals pending for manual review. This is bounded autonomous execution, not a general-purpose agent or shell executor.

## Platform status

- Windows: native tray, opt-in login startup, full-screen transparent always-on-top avatar overlay with click-through outside the character, and managed Rust agent worker.
- macOS/Linux: Tauri shell, tray and startup APIs compile, but this milestone uses a compact overlay without equivalent precise click-through hit-testing.
- Android/iOS: no native companion agent is shipped. Android requires a foreground-service lifecycle and user-visible notification. iOS does not permit an unrestricted always-running daemon or floating overlay over other apps. These are separate platform implementations, not a desktop compile flag.

## Build on Windows

Install Rust stable 1.90 or newer and the Tauri CLI:

    cargo install tauri-cli --locked
    cd native/desktop/src-tauri
    cargo tauri dev

For a production package:

    cargo tauri build

The Windows GitHub Actions workflow builds the frontend, checks the Tauri host, tests the Rust agent, builds the release executable and uploads it as a workflow artifact.

## Native enrollment

Open the dashboard in the desktop application. In Desktop Companion, enter one existing absolute directory path per line, review the scope, and explicitly confirm metadata-only monitoring. The app creates its configuration under the OS app-data directory and starts the worker.

The first version intentionally does not provide automatic broad home-directory, drive-root, or profile enrollment.
