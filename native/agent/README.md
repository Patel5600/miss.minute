# Miss Minutes native local agent

The Rust agent is the local evidence and reasoning core. It can run as a standalone CLI process, or as a managed worker thread inside the Tauri desktop host. In desktop mode, closing the dashboard hides its window; the Tauri process, tray and worker continue until stopped or the app exits.

## Implemented

- Owner-confirmed, explicit directory allowlists.
- Initial recursive inventory of regular files in those roots.
- Cross-platform file-system notifications through the Rust notify crate.
- Periodic metadata reconciliation.
- Local SQLite event ledger with event IDs, observation timestamps, source timestamps and provenance labels.
- Retention pruning for events and decisions.
- Optional local or explicitly approved remote reasoning through an OpenAI-compatible endpoint.
- Evidence-ID validation for model decisions.
- Action proposals always require owner approval; no action executor exists.
- Permanent local-history deletion command.
- Tauri desktop host integration through a managed worker and explicit shutdown token.

## Desktop host integration

See [../desktop/README.md](../desktop/README.md) for the Tauri 2 desktop shell.

The desktop host provides:
- Browser-to-native command and event IPC through Tauri. It does not expose an unauthenticated localhost TCP listener.
- Windows tray controls and opt-in login startup.
- A separate transparent, always-on-top avatar window with pointer pass-through outside the animated character.
- A native worker lifecycle that starts an enrolled agent on app launch and shuts it down cleanly on quit.
- Dashboard-to-avatar speech events, allowing the overlay renderer to animate the mouth against actual TTS playback.

The CLI binary remains useful for local administration and standalone operation. It is not itself registered as a Windows login service; desktop auto-start belongs to the Tauri host.

## Not implemented

- Android or iOS native background agents.
- Active-window, notification, browser-session, screen, audio, microphone, clipboard or keyboard context capture.
- File-content indexing.
- Cross-device sync or cloud task execution.
- Automatic execution of model-proposed actions.
- Streaming all filesystem observations directly into the dashboard or avatar. The current desktop panel reads agent status; the reasoner still writes decisions to its local store/stdout.
- Database encryption at rest.

The current action proposal contains a free-form kind and description. It is deliberately not passed to a shell or arbitrary command runner. Autonomous execution requires a typed capability registry, scoped permissions, durable action queue, dry-run previews, idempotency, approval policies, revocation, and audit records.

## Privacy contract

The agent only accesses directory roots explicitly added with init or confirmed through desktop enrollment.

It reads filesystem metadata (path, size, regular-file status and filesystem modification time). It never opens a file to read its contents. It does not capture keystrokes, clipboard contents, screenshots, audio or private application data. Symlinks are not followed.

The filesystem modification timestamp is not a creation timestamp and is not proof that a human performed an action. Watcher notifications mean the operating system delivered a filesystem event to the process; they do not prove that the owner opened or edited a file.

The collector reports inaccessible entries, watcher failures and queue-overflow coverage gaps. It does not promise complete historical reconstruction. Historical inventory only shows files that exist and are accessible when the scan runs.

The SQLite event store is local but is not encrypted at rest in this milestone. The database contains file paths and metadata, so protect the device account and database directory. API keys are read from environment variables in the agent configuration path and never written to the agent JSON file.

## Build

Install the Rust stable toolchain (Rust 2024 edition; agent MSRV 1.89; desktop host MSRV 1.90):

    cargo test --workspace
    cargo build --release -p miss-minute-agent

For the desktop app, see [native/desktop/README.md](../desktop/README.md).

## Initial enrollment

Review every directory before granting access:

    miss-minute-agent init --config ./miss-minute-agent.json --allow-root ./Projects --allow-root ./Documents --confirm-owner-permission

The command rejects filesystem roots and overlapping allowlisted directories. It does not silently add home directories or drives.

## Standalone collection

    miss-minute-agent run --config ./miss-minute-agent.json

This CLI process continues independently of a browser tab. Stop it with Ctrl+C or the platform termination signal. In the Tauri app, the same collector runs as a managed worker thread and is stopped from the tray or on app exit.

## Inspect collected evidence

    miss-minute-agent status --config ./miss-minute-agent.json
    miss-minute-agent recent --config ./miss-minute-agent.json --limit 50
    miss-minute-agent scan --config ./miss-minute-agent.json

## Enable local reasoning

For a locally running OpenAI-compatible server (for example, Ollama), configure its chat-completions endpoint and a model already installed on that server:

    miss-minute-agent configure-reasoner --config ./miss-minute-agent.json --endpoint http://127.0.0.1:11434/v1/chat/completions --model YOUR_INSTALLED_MODEL

The model must already be installed and the local server must already be running. No model is bundled.

For a remote HTTPS endpoint, supply api-key-env with an environment-variable name and explicitly add confirm-remote-metadata-egress. The agent sends local file paths and metadata to that remote endpoint. It never sends file contents. The API key value is read from the named environment variable and is not saved in JSON.

Inspect decisions:

    miss-minute-agent think --config ./miss-minute-agent.json
    miss-minute-agent decisions --config ./miss-minute-agent.json

A model may decide to remain silent. A speak decision is stored as a candidate; the CLI does not synthesize speech. The desktop UI currently routes dashboard responses to the avatar, but the local filesystem reasoner is not yet wired into the avatar event stream. A proposed action remains a proposal and cannot execute.

## Delete local history

    miss-minute-agent forget-history --config ./miss-minute-agent.json --confirm-permanent-deletion

This deletes the event history, current file metadata index and stored decisions. It retains the configuration and authorized roots.


## Typed task proposals and approved note creation

The reasoner can propose one capability: create a new Markdown note in a separately approved output folder. This is deliberately separate from metadata monitoring consent. A monitored folder does not automatically become writable.

Grant write permission only to a specific existing subfolder inside an already authorized metadata root:

    miss-minute-agent authorize-note-root --config ./miss-minute-agent.json --path ./Projects/Notes --confirm-write-permission

Inspect the exact pending payload before approval:

    miss-minute-agent pending-actions --config ./miss-minute-agent.json
    miss-minute-agent approve-action --config ./miss-minute-agent.json --action-id ACTION_ID --confirm-exact-action

Reject an action:

    miss-minute-agent reject-action --config ./miss-minute-agent.json --action-id ACTION_ID --confirm-rejection

Revoke the output folder permission:

    miss-minute-agent revoke-note-root --config ./miss-minute-agent.json --path ./Projects/Notes

Current execution limits:

- Only one action type exists: create a new top-level Markdown file in an approved note folder.
- File names are restricted to a short ASCII slug and .md.
- Note body is limited to 8192 bytes.
- Existing destinations are never overwritten. Creation uses an exclusive temporary file followed by an atomic hard-link operation.
- Approval expires after 24 hours and is one-shot. Rejection, expiry, revocation and execution are recorded in the local append-only action audit.
- A process crash during execution is treated as an uncertain outcome and requires manual inspection. It is never automatically retried.
- There is no shell, arbitrary script, process-launch, network, file-move or file-delete capability.
- The model sees metadata and the explicitly approved note-output path, never file contents.


### Explicit automatic mode (single capability, hard quota)

The owner can explicitly opt into automatic execution for the one supported `create_note` capability:

    miss-minute-agent set-auto-note-creation --config ./miss-minute-agent.json --enabled true

Disable it:

    miss-minute-agent set-auto-note-creation --config ./miss-minute-agent.json --enabled false

The policy is disabled by default. It cannot be enabled until at least one separate note-output folder is authorized. It is hard-limited to three automatic note-creation attempts per UTC day. A claimed attempt consumes quota even if execution fails or is interrupted, preventing repeated side effects. If the quota is exhausted, new proposals remain pending for manual review. Manual approvals remain available when automatic mode is disabled. The policy never adds a new capability or expands an output folder's scope.

The desktop panel has the same opt-in switch and displays the daily count. The native host stops and joins the worker, persists the new policy, then restarts the worker from the updated config so a stale in-memory policy cannot remain active after the setting operation returns.
