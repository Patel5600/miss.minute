# Miss Minutes native local agent

The Rust agent is the local evidence, context and reasoning core. It can run as a standalone CLI process or as a managed worker thread inside the Tauri desktop host.

## Implemented

- Owner-confirmed, explicit filesystem roots. Initial inventory, filesystem notifications and periodic metadata reconciliation.
- Metadata-only collection: canonical path, regular-file status, size and modification time. No file-content reads, symlink traversal, screenshots, clipboard, keystrokes, microphone, browser history or private application databases.
- Optional Windows foreground-window-title source. It is disabled by default, requires a separate owner toggle, records only title changes and excludes Miss Minutes' own windows.
- Owner-pinned context notes. The owner writes, enables, disables or deletes these through the dashboard. Storage is bounded to 20 notes and 64 KiB aggregate. They are background context, not observed evidence, and cannot expand agent capabilities.
- SQLite evidence ledger encrypted with SQLCipher. A random 256-bit database key is stored in the operating-system credential vault through the keyring backend. Existing plaintext databases are exported to encrypted form with verification and a recoverable backup/rollback path; missing or incorrect keys fail closed.
- Event IDs, observation timestamps, source timestamp semantics, provenance, retention pruning and coverage-gap reporting.
- Optional OpenAI-compatible reasoner, disabled by default. Local plaintext HTTP is loopback-only; remote endpoints require HTTPS and explicit consent to send local metadata and paths.
- Strict decision JSON and evidence-ID validation. Silence is a valid decision.
- A typed create_note action only. New Markdown files in separately approved output roots, strict slug and body limits, exclusive atomic creation, no overwrite.
- Durable pending actions, one-shot claims, 24-hour expiry, evidence references and append-only audit transitions.
- Optional automatic note creation is disabled by default, requires a separate owner grant and is capped at three successful notes per UTC day.
- OS credential-vault operations for supported AI providers. API key values are not stored in the Rust config file.
- Managed worker lifecycle with explicit shutdown token when hosted by Tauri.

## Not implemented

- Cross-device pairing, mobile-to-desktop synchronization or a remote event relay.
- Browser-tab/session context, notification content, screen capture, clipboard, microphone, keyboard or broad application telemetry.
- Arbitrary shell, script, process-launch, network, delete, move or overwrite actions.
- General-purpose autonomous computer control.
- Complete reconstruction of past user activity.

## Desktop integration

See [../desktop/README.md](../desktop/README.md). The dashboard uses a typed Tauri IPC surface. Event reads use a short-lived stream token, bounded pages, durable cursors and explicit acknowledgements. Unacknowledged pages are repeatable; retention gaps are reported rather than silently skipped. The avatar window has only the bounds and drag-state permissions it needs.

## Privacy and evidence limits

The agent accesses only roots explicitly granted by the owner. Filesystem modification times are not creation times and do not prove human activity. Watcher notifications can be coalesced or missed. The collector reports inaccessible entries, watcher failures and queue-overflow coverage gaps; it does not promise complete historical reconstruction.

Owner-pinned context is encrypted at rest with the event database. It is not proof of current facts and is always supplied to the reasoner as untrusted owner-authored background data. Disable or delete notes that are stale.

The desktop credential vault is provided by the operating system. Browser-only mode has no native vault and keeps provider credentials in memory while requests are made; persisted browser settings omit key values.

## Build

Install Rust stable (workspace edition 2024; desktop host requires Rust 1.90 or newer):

    cargo test --workspace
    cargo clippy --workspace --all-targets -- -D warnings
    cargo build --release -p miss-minute-agent

For the desktop app, see [../desktop/README.md](../desktop/README.md).

## Initial enrollment

Review every directory before granting access:

    miss-minute-agent init --config ./miss-minute-agent.json --allow-root ./Projects --confirm-owner-permission

Filesystem roots and overlapping allowlists are rejected. The tool does not silently add home directories or drives.

## Standalone operation

    miss-minute-agent run --config ./miss-minute-agent.json
    miss-minute-agent status --config ./miss-minute-agent.json
    miss-minute-agent recent --config ./miss-minute-agent.json

The CLI process continues independently of a browser tab. Stop it with Ctrl+C. In the Tauri app, the same collector runs as a managed worker thread and is stopped through the tray or on app exit.
