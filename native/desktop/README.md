# Miss Minutes desktop companion

The desktop host is a Tauri 2 application. It embeds the React interface, creates a separate transparent always-on-top avatar window, owns the local IPC boundary, registers login startup and creates a native system-tray menu.

## Windows behavior

- The avatar is a separate desktop-sized transparent window, not an element trapped inside the dashboard.
- The existing SVG renderer supplies delta-time locomotion, eye tracking, blinking, rubber-hose limbs, waving, walking, drag physics and speech-reactive mouth movement.
- A native hit-test loop checks the global pointer against the current character bounds. The overlay passes clicks through outside the character and remains interactive while a drag is in progress.
- The dashboard can be hidden while the companion, tray icon and enrolled local agent remain alive.
- The tray can reopen the dashboard, show or hide the avatar, stop the local agent or quit.
- Login startup is opt-in. Startup launches in background mode, restores the avatar and restarts an existing enrolled worker.
- Dashboard replies and validated local-reasoner speech decisions are sent to the avatar through native Tauri events. The overlay performs TTS and drives mouth movement from audio analysis or speech-boundary events. Native mode disables the old random spoken-chatter timer.

## Browser-to-agent IPC and event delivery

The embedded UI calls registered Tauri commands through the Tauri IPC bridge. There is no unauthenticated localhost TCP listener and no shell-command bridge.

The command surface includes enrollment, status, worker lifecycle, separate note-write grants, exact action approval/rejection, bounded automatic-note policy, owner-pinned context, foreground-window consent, credentials, startup registration, avatar/dashboard visibility and speech.

The dashboard event stream uses:
- a cryptographically unpredictable per-session token;
- a 30-minute expiry and dashboard-window restriction;
- bounded reads of at most 100 events per page;
- an acknowledged durable sequence cursor;
- repeatable page reads until the final sequence is acknowledged;
- explicit retention-gap errors instead of silently skipping pruned history.

This is authenticated local Tauri IPC polling with replay-safe page acknowledgement. It is not a remote push stream or a mobile sync protocol.

## Context and privacy

The collector reads filesystem metadata only from explicit owner-authorized roots. The optional Windows foreground-window-title source is off by default and separately consented. Owner-pinned context notes are manually entered, encrypted in the local database, bounded and removable. These notes are background context, not observed evidence.

The agent does not read file contents, follow symlinks, capture keystrokes, clipboard, screenshots, audio, browser history or private application data. Metadata timestamps are not proof of user activity. Filesystem notifications may be coalesced or missed; current scans cannot reconstruct deleted files or all past activity.

The optional reasoner is disabled by default. Local plaintext HTTP is restricted to loopback. Remote reasoning requires HTTPS and explicit consent to send local paths and metadata. Provider credentials are stored in the operating-system credential vault on desktop. Gemini credentials are sent in the request header rather than the URL.

The desktop evidence database uses SQLCipher with a random 256-bit key stored in the OS credential vault. Missing or incorrect keys fail closed. The renderer receives secrets only when it requests a configured provider credential for an active request; persisted web settings omit API key values.

## Typed task execution

The model cannot return arbitrary commands or scripts. The only native capability currently implemented is create_note:
- the owner separately grants existing note-output subfolders;
- the model can request a new Markdown file only, with an ASCII slug and an 8192-byte body limit;
- the owner can inspect the exact target path and complete note body, then approve or reject;
- creation is exclusive and fails if the destination already exists;
- pending proposals expire after 24 hours, are one-shot and have durable audit transitions;
- revoking a note-output grant expires pending proposals;
- interrupted executions are not automatically retried.

A separate automatic-note-creation switch is off by default. When explicitly enabled, the host may execute only create_note inside separately approved output roots, capped at three successful notes per UTC day. This is bounded autonomous execution, not general-purpose computer control.

## Platform status

- Windows: native tray, opt-in login startup, transparent always-on-top avatar overlay with click-through outside the character and managed Rust worker.
- macOS/Linux: Tauri shell, tray and startup APIs; compact overlay without equivalent precise click-through hit-testing.
- Android: separate native companion with explicit document-tree selection, visible foreground service, bounded metadata scans and SQLCipher local storage protected by Android Keystore.
- iOS: separate SwiftUI companion with owner-selected security-scoped folder, Keychain bookmark and opportunistic BackgroundTasks refresh with iOS file protection.

Mobile-to-desktop pairing and event synchronization are not implemented. iOS does not permit an unrestricted daemon or cross-app floating avatar.

## Release validation

CI verifies frontend build/lint, Rust tests, Windows Tauri compilation and mobile debug/simulator builds. CI does not verify physical desktop interaction. A Windows smoke test on a real desktop is still required for DPI/multi-monitor placement, click-through, dragging, speech playback, login startup and sleep/resume. Signed distribution requires owner-held signing certificates and protected CI secrets; without them the Windows executable is explicitly marked unsigned.
